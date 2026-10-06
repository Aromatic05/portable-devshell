import type { WorkerInstance as WorkerInstanceApi } from "../Api.js";
import type { InstanceEventInput, InstanceEventStreamGap, InstanceEventStreamSlice, WorkerExecProcessInput, WorkerTcpConnectInput, WorkerCommandSessionClose, WorkerCommandSessionCompletion, WorkerCommandSessionOpen, WorkerCommandSessionOutput, WorkerAlertsReadResult, WorkerExtensionResourcePrepareInput, WorkerExtensionResourcePrepareResult, WorkerHandshakeResult, WorkerWorkspacePrepareResult, WorkerTerminalAttachResult, WorkerTerminalDescriptor, WorkerTerminalIdentity, WorkerTerminalNotification, WorkerTerminalOpenInput, InstanceEventPort } from "../Api.js";
import {
    type Endpoint,
    type MessageStream,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ReverseEnrollmentState,
    type ReverseTransport,
    type ToolDefinition,
    type WorkerArtifactApi,
} from "@portable-devshell/shared";


import type { WorkerCommandClient } from "./execution/Command.js";
import type { WorkerCommandInteractiveSession } from "../Api.js";
import type { TransportConnection } from "../transport/endpoint/Connection.js";
import { WorkerTunnel } from "../transport/packet/Tunnel.js";
import { WorkerCommandSessionBridge } from "./execution/Session.js";
import type { WorkerProtocolClient } from "../transport/packet/Client.js";
import { createWorkerArtifact } from "../transport/packet/Artifact.js";
import type { Channel } from "@portable-devshell/shared";

import { WorkerTerminal } from "../transport/packet/Terminal.js";
import type { InstanceStateMachine } from "./supervision/State.js";
import type { InstanceSnapshot } from "./supervision/State.js";

import type { ResolvedWorkerInstanceConfig } from "./provision/Config.js";
import { WorkerInstanceConnection } from "./supervision/Connection.js";
import { WorkerInstanceSupervision } from "./supervision/Recovery.js";
import { WorkerInstanceLifecycle } from "./execution/Lifecycle.js";
import { ReverseExecution } from "./execution/provider/Reverse.js";
import { WorkerInstanceRetirement } from "./provision/Retirement.js";
import { WorkerInstanceState } from "./supervision/State.js";

interface WorkerInstanceDependencies {
    commandClient?: WorkerCommandClient;
    config: ResolvedWorkerInstanceConfig;
    events: InstanceEventPort;
    endpoint: Endpoint;
    protocolClient: WorkerProtocolClient;
    stateMachine: InstanceStateMachine;
    transportConnection: TransportConnection;
}

export class WorkerInstance implements WorkerInstanceApi {
    readonly artifact: WorkerArtifactApi;
    readonly #commandSessions: WorkerCommandSessionBridge;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #endpoint: Endpoint;
    readonly #connection: WorkerInstanceConnection;
    readonly #lifecycle: WorkerInstanceLifecycle;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #state: WorkerInstanceState;
    readonly #supervision: WorkerInstanceSupervision;
    readonly #terminal: WorkerTerminal;
    readonly #tunnel: WorkerTunnel;
    readonly #retirement: WorkerInstanceRetirement;
    #operationTail: Promise<void> = Promise.resolve();

    constructor(dependencies: WorkerInstanceDependencies) {
        this.#config = dependencies.config;
        this.#endpoint = dependencies.endpoint;
        this.#protocolClient = dependencies.protocolClient;
        this.#state = new WorkerInstanceState({
            config: this.#config,
            events: dependencies.events,
            stateMachine: dependencies.stateMachine,
        });
        const workerHost = `${this.#config.name}-worker`;
        this.artifact = guardArtifact(
            createWorkerArtifact(dependencies.endpoint, workerHost),
            () => this.#assertReady(),
        );
        this.#commandSessions = new WorkerCommandSessionBridge(
            dependencies.endpoint,
            workerHost,
            dependencies.protocolClient,
        );
        this.#tunnel = new WorkerTunnel(
            dependencies.endpoint,
            workerHost,
        );
        this.#terminal = new WorkerTerminal(dependencies.endpoint, workerHost);
        this.#connection = new WorkerInstanceConnection({
            appendEvent: (type, data) => this.#state.appendEvent(type, data),
            applyStateUpdate: (update) =>
                this.#state.apply(update, this.#connection.snapshotReverse()),
            config: this.#config,
            protocolClient: dependencies.protocolClient,
            endpoint: dependencies.endpoint,
            snapshot: () => this.snapshot(),
            transportConnection: dependencies.transportConnection,
        });
        const reverse =
            this.#config.managementMode === "selfManaged"
                ? new ReverseExecution({
                      applyStateUpdate: (update) =>
                          this.#state.apply(
                              update,
                              this.#connection.snapshotReverse(),
                          ),
                      connection: this.#connection,
                      name: this.#config.name,
                  })
                : undefined;
        this.#supervision = new WorkerInstanceSupervision({
            applyStateUpdate: (update) =>
                this.#state.apply(update, this.#connection.snapshotReverse()),
            commandClient: dependencies.commandClient,
            config: this.#config,
            connection: this.#connection,
            reverse,
        });
        this.#lifecycle = new WorkerInstanceLifecycle({
            appendEvent: (type) => this.#state.appendEvent(type),
            applyStateUpdate: (update) =>
                this.#state.apply(update, this.#connection.snapshotReverse()),
            commandClient: dependencies.commandClient,
            config: this.#config,
            connection: this.#connection,
            refreshStatus: () => this.#supervision.refreshStatus(),
            reverse,
        });
        this.#retirement = new WorkerInstanceRetirement({
            commandClient: dependencies.commandClient,
            config: this.#config,
        });
    }

    snapshot(): InstanceSnapshot {
        return this.#state.snapshot(this.#connection.snapshotReverse());
    }

    get endpoint(): Endpoint {
        return this.#endpoint;
    }

    async readWorkerTools(): Promise<readonly ToolDefinition[]> {
        return (await this.#protocolClient.listTools()).tools;
    }

    get managementMode(): ResolvedWorkerInstanceConfig["managementMode"] {
        return this.#config.managementMode;
    }

    async retireProviderResources(): Promise<void> {
        await this.#runExclusive(
            async () => await this.#retirement.retireProviderResources(),
        );
    }

    async retireRuntime(): Promise<void> {
        await this.#runExclusive(
            async () => await this.#retirement.retireRuntime(),
        );
    }

    async setReverseEnrollmentState(
        enrollmentState: ReverseEnrollmentState,
    ): Promise<InstanceSnapshot> {
        return await this.#connection.setReverseEnrollmentState(
            enrollmentState,
        );
    }

    async acceptReverseChannel(
        channel: Channel,
        input: {
            connectedAt?: string;
            generation: number;
            transport: ReverseTransport;
        },
    ): Promise<InstanceSnapshot> {
        return await this.#connection.acceptReverseChannel(channel, input);
    }

    async connectTcp(
        input: WorkerTcpConnectInput,
        signal?: AbortSignal,
    ): Promise<MessageStream> {
        this.#assertReady();
        return await this.#tunnel.connectTcp(input, signal);
    }

    async execProcess(
        input: WorkerExecProcessInput,
        signal?: AbortSignal,
    ): Promise<MessageStream> {
        this.#assertReady();
        return await this.#tunnel.execProcess(input, signal);
    }

    async openTerminal(
        input: WorkerTerminalOpenInput,
    ): Promise<WorkerTerminalDescriptor> {
        return await this.#terminal.open(input);
    }

    async prepareWorkspace(
        workspace: string,
    ): Promise<WorkerWorkspacePrepareResult> {
        this.#assertReady();
        return await this.#protocolClient.prepareWorkspace(workspace);
    }

    async readAlerts(
        workspace: string,
    ): Promise<WorkerAlertsReadResult> {
        this.#assertReady();
        return await this.#protocolClient.readAlerts(
            workspace,
            this.#config.alerts,
        );
    }

    async touchAlerts(
        workspace: string,
    ): Promise<WorkerAlertsReadResult> {
        this.#assertReady();
        return await this.#protocolClient.touchAlerts(
            workspace,
            this.#config.alerts,
        );
    }

    async releaseAlerts(workspace: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.releaseAlerts(workspace);
    }

    async touchTemporaryDirectory(path: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.touchTemporaryDirectory(path);
    }

    async attachTerminal(input: {
        fromSeq: number;
        generation: number;
        terminalId: string;
    }): Promise<WorkerTerminalAttachResult> {
        return await this.#terminal.attach(input);
    }

    async writeTerminal(
        input: WorkerTerminalIdentity & { data: string },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return await this.#terminal.write(input);
    }

    async resizeTerminal(
        input: WorkerTerminalIdentity & { cols: number; rows: number },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return await this.#terminal.resize(input);
    }

    async killTerminal(
        input: WorkerTerminalIdentity,
    ): Promise<WorkerTerminalDescriptor> {
        return await this.#terminal.kill(input);
    }

    async listTerminals(): Promise<WorkerTerminalDescriptor[]> {
        return await this.#terminal.list();
    }

    onTerminalNotification(
        listener: (notification: WorkerTerminalNotification) => void,
    ): () => void {
        return this.#terminal.onNotification(listener);
    }

    onTransportConnected(listener: () => void): () => void {
        return this.#terminal.onConnected(listener);
    }

    onTransportDisconnected(listener: (error: Error) => void): () => void {
        return this.#terminal.onDisconnected(listener);
    }

    onCommandSessionOpen(
        listener: (request: WorkerCommandSessionOpen) => void,
    ): () => void {
        return this.#commandSessions.onOpen(listener);
    }

    onCommandSessionClose(
        listener: (request: WorkerCommandSessionClose) => void,
    ): () => void {
        return this.#commandSessions.onClose(listener);
    }

    async writeCommandSessionOutput(
        output: WorkerCommandSessionOutput,
    ): Promise<void> {
        await this.#commandSessions.output(output);
    }

    async completeCommandSession(
        completion: WorkerCommandSessionCompletion,
    ): Promise<void> {
        await this.#commandSessions.complete(completion);
    }

    async appendControlEvent(
        type: InstanceEventInput["type"],
        data?: JsonValue,
    ) {
        return await this.#state.appendEvent(type, data);
    }

    async prepareExtensionResource(
        input: WorkerExtensionResourcePrepareInput,
    ): Promise<WorkerExtensionResourcePrepareResult> {
        this.#assertReady();
        return await this.#protocolClient.prepareExtensionResource(input);
    }

    async start(): Promise<InstanceSnapshot> {
        return await this.#runExclusive(
            async () => await this.#lifecycle.start(),
        );
    }

    async startInteractive(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<InstanceSnapshot> {
        return await this.#runExclusive(
            async () =>
                await this.#lifecycle.startInteractive(interactiveSession),
        );
    }

    async stop(): Promise<InstanceSnapshot> {
        return await this.#runExclusive(
            async () => await this.#lifecycle.stop(),
        );
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        return await this.#runExclusive(
            async () => await this.#supervision.refreshStatus(),
        );
    }

    async reconfigure(input: {
        alerts?: ResolvedWorkerInstanceConfig["alerts"];
        effectiveSecurityMode: ResolvedWorkerInstanceConfig["effectiveSecurityMode"];
        env?: NodeJS.ProcessEnv;
    }): Promise<void> {
        this.#config.alerts = input.alerts;
        this.#config.effectiveSecurityMode = input.effectiveSecurityMode;
        this.#config.env = input.env;
        if (this.snapshot().ready) {
            await this.#protocolClient.configureAlerts(input.alerts);
        }
    }

    subscribe(fromSeq = 1): InstanceEventStreamGap | InstanceEventStreamSlice {
        return this.#state.subscribe(fromSeq);
    }

    async close(): Promise<void> {
        await this.#runExclusive(async () => {
            try {
                await this.#supervision.close();
            } finally {
                this.#commandSessions.close();
            }
        });
    }

    get handshake(): WorkerHandshakeResult | undefined {
        return this.#connection.handshake;
    }

    async reconnectTransport(): Promise<InstanceSnapshot> {
        return await this.#runExclusive(
            async () => await this.#supervision.reconnectTransport(),
        );
    }

    async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.#operationTail.then(operation, operation);
        this.#operationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return await result;
    }

    #assertReady(): void {
        if (this.snapshot().ready) {
            return;
        }
        throw createRemoteError({
            code: runtimeErrorCodes.instanceNotReady,
            message: `Instance ${this.#config.name} is not ready.`,
            retryable: false,
            details: { instanceName: this.#config.name },
        });
    }
}

function guardArtifact(
    artifact: WorkerArtifactApi,
    assertReady: () => void,
): WorkerArtifactApi {
    return {
        abortArtifactReceive: async (receiveId) => {
            assertReady();
            await artifact.abortArtifactReceive(receiveId);
        },
        beginArtifactReceive: async (input, signal) => {
            assertReady();
            return await artifact.beginArtifactReceive(input, signal);
        },
        closeArtifactPayload: async (payloadId) => {
            assertReady();
            await artifact.closeArtifactPayload(payloadId);
        },
        finishArtifactReceive: async (receiveId) => {
            assertReady();
            return await artifact.finishArtifactReceive(receiveId);
        },
        openArtifactPayload: async (input, signal) => {
            assertReady();
            return await artifact.openArtifactPayload(input, signal);
        },
        readArtifactPayload: async (input, signal) => {
            assertReady();
            return await artifact.readArtifactPayload(input, signal);
        },
        writeArtifactReceive: async (input, signal) => {
            assertReady();
            return await artifact.writeArtifactReceive(input, signal);
        },
        ...(artifact.openArtifactDirectReceive === undefined
            ? {}
            : {
                  openArtifactDirectReceive: async (input, signal) => {
                      assertReady();
                      return await artifact.openArtifactDirectReceive!(
                          input,
                          signal,
                      );
                  },
              }),
        ...(artifact.closeArtifactDirectReceive === undefined
            ? {}
            : {
                  closeArtifactDirectReceive: async (receiverId) => {
                      assertReady();
                      await artifact.closeArtifactDirectReceive!(receiverId);
                  },
              }),
        ...(artifact.pushArtifactPayloadDirect === undefined
            ? {}
            : {
                  pushArtifactPayloadDirect: async (input) => {
                      assertReady();
                      return await artifact.pushArtifactPayloadDirect!(input);
                  },
              }),
    };
}
