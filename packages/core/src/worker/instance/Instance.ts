import {
    type Endpoint,
    type InstanceName,
    type MessageStream,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallRecord,
    type ReverseEnrollmentState,
    type ReverseTransport,
} from "@portable-devshell/shared";

import type { AuditDatabase } from "../../storage/audit/database/Database.js";
import type {
    InstanceEventInput,
    InstanceEventStreamGap,
    InstanceEventStreamSlice,
} from "../../instance/EventBuffer.js";
import type { LogQuery } from "../../storage/log/Query.js";
import type { InstanceLogEntry } from "../../storage/log/Store.js";
import type { WorkerCommandClient } from "../transport/command/Client.js";
import type { WorkerCommandInteractiveSession } from "../transport/command/Transport.js";
import type { WorkerTransportConnection } from "../transport/Transport.js";
import { WorkerTransportServiceClient } from "../transport/service/Client.js";
import type {
    WorkerArtifactPayloadReadInput,
    WorkerArtifactPayloadReadResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult,
    WorkerExecProcessInput,
    WorkerTcpConnectInput,
} from "../transport/service/Model.js";
import {
    WorkerCommandSessionBridge,
    type WorkerCommandSessionClose,
    type WorkerCommandSessionCompletion,
    type WorkerCommandSessionOpen,
    type WorkerCommandSessionOutput,
} from "../protocol/CommandSession.js";
import type {
    WorkerArtifactDirectPushInput,
    WorkerArtifactDirectPushResult,
    WorkerArtifactDirectReceiveOpenInput,
    WorkerArtifactDirectReceiveOpenResult,
    WorkerArtifactPayloadOpenInput,
    WorkerArtifactPayloadOpenResult,
    WorkerArtifactReceiveBeginInput,
    WorkerArtifactReceiveBeginResult,
    WorkerArtifactReceiveFinishResult,
    WorkerExtensionResourcePrepareInput,
    WorkerExtensionResourcePrepareResult,
    WorkerHandshakeResult,
    WorkerProtocolClient,
} from "../protocol/Client.js";
import type { Channel } from "@portable-devshell/shared";
import type { WorkerToolCatalog } from "../tool/Catalog.js";
import type { WorkerToolInvoker } from "../tool/Invoker.js";
import type { WorkerToolCallScheduler } from "../tool/Scheduler.js";
import type {
    WorkerTerminalAttachResult,
    WorkerTerminalClient,
    WorkerTerminalDescriptor,
    WorkerTerminalIdentity,
    WorkerTerminalNotification,
    WorkerTerminalOpenInput,
} from "../protocol/Terminal.js";
import type { AuditToolCallHistory } from "../../storage/audit/ToolCallHistory.js";
import type { InstanceStateMachine } from "../../instance/state/Machine.js";
import type { InstanceSnapshot } from "../../instance/state/Snapshot.js";
import type { InstanceEventBuffer } from "../../instance/EventBuffer.js";
import type { LogStoreInstance } from "../../storage/log/Store.js";
import type { ResolvedWorkerInstanceConfig } from "./Config.js";
import { WorkerInstanceTool } from "./tool/Tool.js";
import type { ToolCallTarget } from "../../tool/Pipeline.js";
import { WorkerInstanceConnection } from "./lifecycle/Connection.js";
import { WorkerInstanceLifecycle } from "./lifecycle/Lifecycle.js";
import { WorkerInstanceArtifact } from "./capability/Artifact.js";
import { WorkerInstanceAudit } from "./capability/Audit.js";
import { WorkerInstanceState } from "./state/State.js";

interface WorkerInstanceDependencies {
    auditDatabase: AuditDatabase;
    catalog: WorkerToolCatalog;
    commandClient?: WorkerCommandClient;
    config: ResolvedWorkerInstanceConfig;
    eventBuffer: InstanceEventBuffer;
    logStore: LogStoreInstance;
    protocolClient: WorkerProtocolClient;
    endpoint: Endpoint;
    stateMachine: InstanceStateMachine;
    terminalClient: WorkerTerminalClient;
    transportConnection: WorkerTransportConnection;
    toolCallHistory: AuditToolCallHistory;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstance {
    readonly #artifact: WorkerInstanceArtifact;
    readonly #audit: WorkerInstanceAudit;
    readonly #catalog: WorkerToolCatalog;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #connection: WorkerInstanceConnection;
    readonly #commandSessions: WorkerCommandSessionBridge;
    readonly #lifecycle: WorkerInstanceLifecycle;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #state: WorkerInstanceState;
    readonly #services: WorkerTransportServiceClient;
    readonly #terminalClient: WorkerTerminalClient;
    readonly #tool: WorkerInstanceTool;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(dependencies: WorkerInstanceDependencies) {
        this.#catalog = dependencies.catalog;
        this.#config = dependencies.config;
        this.#protocolClient = dependencies.protocolClient;
        this.#state = new WorkerInstanceState({
            config: this.#config,
            eventBuffer: dependencies.eventBuffer,
            stateMachine: dependencies.stateMachine,
        });
        this.#connection = new WorkerInstanceConnection({
            appendEvent: (type, data) => this.#state.appendEvent(type, data),
            applyStateUpdate: (update) =>
                this.#state.apply(update, this.#connection.snapshotReverse()),
            catalog: this.#catalog,
            config: this.#config,
            protocolClient: dependencies.protocolClient,
            endpoint: dependencies.endpoint,
            snapshot: () => this.snapshot(),
            transportConnection: dependencies.transportConnection,
        });
        const workerHost = `${this.#config.name}-worker`;
        this.#commandSessions = new WorkerCommandSessionBridge(
            dependencies.endpoint,
            workerHost,
            dependencies.protocolClient,
        );
        this.#services = new WorkerTransportServiceClient(
            dependencies.endpoint,
            workerHost,
        );
        this.#terminalClient = dependencies.terminalClient;
        this.#lifecycle = new WorkerInstanceLifecycle({
            appendEvent: (type) => this.#state.appendEvent(type),
            applyStateUpdate: (update) =>
                this.#state.apply(update, this.#connection.snapshotReverse()),
            commandClient: dependencies.commandClient,
            config: this.#config,
            connection: this.#connection,
        });
        this.#artifact = new WorkerInstanceArtifact({
            assertReady: () => this.#assertReady(),
            protocolClient: dependencies.protocolClient,
            serviceClient: this.#services,
        });
        this.#audit = new WorkerInstanceAudit({
            appendEvent: (type, data) => this.#state.appendEvent(type, data),
            auditDatabase: dependencies.auditDatabase,
            isReady: () => this.snapshot().ready,
            protocolClient: dependencies.protocolClient,
        });
        this.#tool = new WorkerInstanceTool({
            appendEvent: (type, data) => this.#state.appendEvent(type, data),
            assertReady: () => this.#assertReady(),
            instanceName: this.#config.name,
            logStore: dependencies.logStore,
            toolCallHistory: dependencies.toolCallHistory,
            toolCallScheduler: dependencies.toolCallScheduler,
            toolInvoker: dependencies.toolInvoker,
        });
        this.#toolInvoker = dependencies.toolInvoker;
    }

    snapshot(): InstanceSnapshot {
        return this.#state.snapshot(this.#connection.snapshotReverse());
    }

    get managementMode(): ResolvedWorkerInstanceConfig["managementMode"] {
        return this.#config.managementMode;
    }

    async retireProviderResources(): Promise<void> {
        await this.#lifecycle.retireProviderResources();
    }

    async retireRuntime(): Promise<void> {
        await this.#lifecycle.retireRuntime();
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
        return await this.#services.connectTcp(input, signal);
    }

    async execProcess(
        input: WorkerExecProcessInput,
        signal?: AbortSignal,
    ): Promise<MessageStream> {
        this.#assertReady();
        return await this.#services.execProcess(input, signal);
    }

    async openTerminal(
        input: WorkerTerminalOpenInput,
    ): Promise<WorkerTerminalDescriptor> {
        return await this.#terminalClient.open(input);
    }

    async prepareWorkspace(
        workspace: string,
    ): Promise<Awaited<ReturnType<WorkerProtocolClient["prepareWorkspace"]>>> {
        this.#assertReady();
        return await this.#protocolClient.prepareWorkspace(workspace);
    }

    async readAlerts(
        workspace: string,
    ): Promise<Awaited<ReturnType<WorkerProtocolClient["readAlerts"]>>> {
        this.#assertReady();
        return await this.#protocolClient.readAlerts(
            workspace,
            this.#config.alerts,
        );
    }

    async touchAlerts(
        workspace: string,
    ): Promise<Awaited<ReturnType<WorkerProtocolClient["touchAlerts"]>>> {
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
        return await this.#terminalClient.attach(input);
    }

    async writeTerminal(
        input: WorkerTerminalIdentity & { data: string },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return await this.#terminalClient.write(input);
    }

    async resizeTerminal(
        input: WorkerTerminalIdentity & { cols: number; rows: number },
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return await this.#terminalClient.resize(input);
    }

    async killTerminal(
        input: WorkerTerminalIdentity,
    ): Promise<WorkerTerminalDescriptor> {
        return await this.#terminalClient.kill(input);
    }

    async listTerminals(): Promise<WorkerTerminalDescriptor[]> {
        return await this.#terminalClient.list();
    }

    onTerminalNotification(
        listener: (notification: WorkerTerminalNotification) => void,
    ): () => void {
        return this.#terminalClient.onNotification(listener);
    }

    onTransportConnected(listener: () => void): () => void {
        return this.#terminalClient.onConnected(listener);
    }

    onTransportDisconnected(listener: (error: Error) => void): () => void {
        return this.#terminalClient.onDisconnected(listener);
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

    listTools() {
        return this.#catalog.listTools();
    }

    hasToolSchemaCache(): boolean {
        return this.#catalog.hasSchema();
    }

    async openArtifactPayload(
        input: WorkerArtifactPayloadOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadOpenResult> {
        return await this.#artifact.openPayload(input, signal);
    }

    async readArtifactPayload(
        input: WorkerArtifactPayloadReadInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadReadResult> {
        return await this.#artifact.readPayload(input, signal);
    }

    async closeArtifactPayload(payloadId: string): Promise<void> {
        await this.#artifact.closePayload(payloadId);
    }

    async prepareExtensionResource(
        input: WorkerExtensionResourcePrepareInput,
    ): Promise<WorkerExtensionResourcePrepareResult> {
        this.#assertReady();
        return await this.#protocolClient.prepareExtensionResource(input);
    }

    async beginArtifactReceive(
        input: WorkerArtifactReceiveBeginInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveBeginResult> {
        return await this.#artifact.beginReceive(input, signal);
    }

    async writeArtifactReceive(
        input: WorkerArtifactReceiveWriteInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveWriteResult> {
        return await this.#artifact.writeReceive(input, signal);
    }

    async finishArtifactReceive(
        receiveId: string,
    ): Promise<WorkerArtifactReceiveFinishResult> {
        return await this.#artifact.finishReceive(receiveId);
    }

    async abortArtifactReceive(receiveId: string): Promise<void> {
        await this.#artifact.abortReceive(receiveId);
    }

    async openArtifactDirectReceive(
        input: WorkerArtifactDirectReceiveOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactDirectReceiveOpenResult> {
        return await this.#artifact.openDirectReceive(input, signal);
    }

    async closeArtifactDirectReceive(receiverId: string): Promise<void> {
        await this.#artifact.closeDirectReceive(receiverId);
    }

    async pushArtifactPayloadDirect(
        input: WorkerArtifactDirectPushInput,
    ): Promise<WorkerArtifactDirectPushResult> {
        return await this.#artifact.pushPayloadDirect(input);
    }

    async start(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.start();
    }

    async startInteractive(
        interactiveSession?: WorkerCommandInteractiveSession,
    ): Promise<InstanceSnapshot> {
        return await this.#lifecycle.startInteractive(interactiveSession);
    }

    async stop(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.stop();
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.refreshStatus();
    }

    toolCallTarget(): ToolCallTarget {
        return this.#tool.target();
    }

    async invokeToolInternal(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        this.#assertReady();
        return await this.#toolInvoker.invoke(toolName, input, context, signal);
    }

    async observeTmuxTask(
        taskId: string,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue> {
        this.#assertReady();
        const listed = await this.#toolInvoker.invoke(
            "tmux_manage",
            { command: "list" },
            context,
            signal,
        );
        const active = findTmuxTask(listed, taskId);
        if (active !== undefined) return { task: active };
        return await this.#toolInvoker.invoke(
            "tmux_read",
            { task: taskId, line: 0, consumeOutput: false },
            context,
            signal,
        );
    }

    async readLogs(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        return await this.#tool.readLogs(query);
    }

    async readToolCalls(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#tool.readToolCalls(query);
    }

    hasActiveToolCalls(ctxId: string, excludeCallId?: string): boolean {
        return this.#tool.hasActiveToolCalls(ctxId, excludeCallId);
    }

    async readToolCallFailureSummary(sinceMs: number, untilMs: number) {
        return await this.#tool.readToolCallFailureSummary(sinceMs, untilMs);
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

    async appendMcpSessionOpened(sessionId: string): Promise<void> {
        await this.#audit.appendMcpSessionOpened(sessionId);
    }

    async appendMcpSessionClosed(sessionId: string): Promise<void> {
        await this.#audit.appendMcpSessionClosed(sessionId);
    }

    async releaseToolSession(sessionId: string): Promise<void> {
        await this.#audit.releaseToolSession(sessionId);
    }

    async appendMcpToolCalled(
        toolName: string,
        context: { requestId?: string; ctxId?: string },
    ): Promise<void> {
        await this.#audit.appendMcpToolCalled(toolName, context);
    }

    subscribe(fromSeq = 1): InstanceEventStreamGap | InstanceEventStreamSlice {
        return this.#state.subscribe(fromSeq);
    }

    async close(): Promise<void> {
        try {
            await this.#lifecycle.closeConnection();
        } finally {
            this.#commandSessions.close();
            this.#audit.close();
        }
    }

    get handshake(): WorkerHandshakeResult | undefined {
        return this.#connection.handshake;
    }

    async reconnectTransport(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.reconnectTransport();
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

function findTmuxTask(
    result: JsonValue,
    taskId: string,
): Record<string, JsonValue> | undefined {
    if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        !Array.isArray(result.panes)
    ) {
        return undefined;
    }
    for (const pane of result.panes) {
        if (typeof pane !== "object" || pane === null || Array.isArray(pane))
            continue;
        const task = pane.task;
        if (typeof task !== "object" || task === null || Array.isArray(task))
            continue;
        if (task.id === taskId) return task;
    }
    return undefined;
}
