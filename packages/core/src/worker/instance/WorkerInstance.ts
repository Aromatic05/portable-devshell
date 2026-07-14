import {
    type ApprovalDecision,
    type ApprovalRequest,
    createError,
    errorCodes,
    type JsonValue,
    type ToolCallAssociation,
    type ToolCallContext,
    type ToolCallQuery,
    type ToolCallRecord,
    type ReverseEnrollmentState,
    type ReverseTransport,
    type WorkspacePath
} from "@portable-devshell/shared";

import type { ApprovalManager } from "../../approval/ApprovalInfra.js";
import type { EventStreamGap, EventStreamSlice, InstanceEventInput } from "../../log/LogEventBuffer.js";
import { InstanceEventBuffer } from "../../log/LogEventBuffer.js";
import type { LogQuery } from "../../log/LogQuery.js";
import { InstanceLogStore, type InstanceLogEntry } from "../../log/store/LogStoreInstance.js";
import { WorkerCommandClient } from "../../worker/command/WorkerCommandClient.js";
import type { WorkerCommandInteractiveSession } from "../../worker/command/WorkerCommandTransport.js";
import {
    WorkerProtocolClient,
    type WorkerArtifactPayloadOpenInput,
    type WorkerArtifactPayloadOpenResult,
    type WorkerArtifactPayloadReadInput,
    type WorkerArtifactPayloadReadResult,
    type WorkerArtifactReceiveBeginInput,
    type WorkerArtifactReceiveBeginResult,
    type WorkerArtifactReceiveFinishResult,
    type WorkerArtifactReceiveWriteInput,
    type WorkerArtifactReceiveWriteResult,
    type WorkerHandshakeResult
} from "../../worker/protocol/WorkerProtocolClient.js";
import { WorkerRpcBridge } from "../../worker/rpc/WorkerRpcBridge.js";
import type { WorkerRpcChannel } from "../../worker/rpc/WorkerRpcChannel.js";
import { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import { ToolCallScheduler } from "../tool/ToolCallScheduler.js";
import { ToolCallHistory } from "../../log/LogToolCallHistory.js";
import { InstanceStateMachine, type InstanceStateUpdate } from "../../instance/state/InstanceStateMachine.js";
import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";
import type { ResolvedWorkerInstanceConfig } from "./WorkerInstanceConfig.js";
import {
    getErrorCode,
    toJsonDetails,
    withInstanceDetails,
    wrapWorkerCommandError
} from "./WorkerInstanceError.js";
import {
    createConnectionChangedEventData,
    createReadyChangedEventData,
    createStatusChangedEventData,
    toEventData
} from "./WorkerInstanceEvent.js";
import { normalizeLifecycleStatus, parseWorkerStatus } from "./WorkerInstanceStatus.js";
import { WorkerInstanceTool } from "./WorkerInstanceTool.js";
import { WorkerInstanceConnection } from "./WorkerInstanceConnection.js";

interface WorkerInstanceDependencies {
    approvalManager: ApprovalManager;
    catalog: WorkerToolCatalog;
    commandClient?: WorkerCommandClient;
    config: ResolvedWorkerInstanceConfig;
    eventBuffer: InstanceEventBuffer;
    logStore: InstanceLogStore;
    protocolClient: WorkerProtocolClient;
    rpcBridge: WorkerRpcBridge;
    stateMachine: InstanceStateMachine;
    toolCallAssociationProvider?: () => ToolCallAssociation | undefined;
    toolCallHistory: ToolCallHistory;
    toolCallScheduler: ToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstance {
    readonly #approvalManager: ApprovalManager;
    readonly #catalog: WorkerToolCatalog;
    readonly #connection: WorkerInstanceConnection;
    readonly #commandClient?: WorkerCommandClient;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #eventBuffer: InstanceEventBuffer;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #stateMachine: InstanceStateMachine;
    readonly #tool: WorkerInstanceTool;

    constructor(dependencies: WorkerInstanceDependencies) {
        this.#approvalManager = dependencies.approvalManager;
        this.#catalog = dependencies.catalog;
        this.#commandClient = dependencies.commandClient;
        this.#config = dependencies.config;
        this.#eventBuffer = dependencies.eventBuffer;
        this.#protocolClient = dependencies.protocolClient;
        this.#stateMachine = dependencies.stateMachine;
        this.#tool = new WorkerInstanceTool({
            approvalManager: this.#approvalManager,
            appendEvent: (type, data) => this.#appendEvent(type, data),
            assertReady: () => this.#assertReady(),
            instanceName: this.#config.name,
            logStore: dependencies.logStore,
            toolCallAssociationProvider: dependencies.toolCallAssociationProvider,
            toolCallHistory: dependencies.toolCallHistory,
            toolCallScheduler: dependencies.toolCallScheduler,
            toolInvoker: dependencies.toolInvoker
        });
        this.#connection = new WorkerInstanceConnection({
            appendEvent: (type, data) => this.#appendEvent(type, data),
            applyStateUpdate: (update) => this.#applyStateUpdate(update),
            catalog: this.#catalog,
            config: this.#config,
            protocolClient: this.#protocolClient,
            rpcBridge: dependencies.rpcBridge,
            snapshot: () => this.snapshot()
        });
    }

    snapshot(): InstanceSnapshot {
        return {
            ...this.#stateMachine.snapshot(),
            effectiveSecurityMode: this.#config.effectiveSecurityMode,
            ...(this.#connection.snapshotReverse() === undefined ? {} : { reverse: this.#connection.snapshotReverse() })
        };
    }

    get managementMode(): ResolvedWorkerInstanceConfig["managementMode"] {
        return this.#config.managementMode;
    }

    async setReverseEnrollmentState(enrollmentState: ReverseEnrollmentState): Promise<InstanceSnapshot> {
        return await this.#connection.setReverseEnrollmentState(enrollmentState);
    }

    async acceptReverseChannel(
        channel: WorkerRpcChannel,
        input: { connectedAt?: string; generation: number; transport: ReverseTransport }
    ): Promise<InstanceSnapshot> {
        return await this.#connection.acceptReverseChannel(channel, input);
    }

    async appendControlEvent(type: InstanceEventInput["type"], data?: JsonValue) {
        return await this.#appendEvent(type, data);
    }

    listTools() {
        return this.#catalog.listTools();
    }

    hasToolSchemaCache(): boolean {
        return this.#catalog.hasSchema();
    }

    async openArtifactPayload(input: WorkerArtifactPayloadOpenInput): Promise<WorkerArtifactPayloadOpenResult> {
        this.#assertReady();
        return await this.#protocolClient.openArtifactPayload(input);
    }

    async readArtifactPayload(input: WorkerArtifactPayloadReadInput): Promise<WorkerArtifactPayloadReadResult> {
        this.#assertReady();
        return await this.#protocolClient.readArtifactPayload(input);
    }

    async closeArtifactPayload(payloadId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.closeArtifactPayload(payloadId);
    }

    async beginArtifactReceive(input: WorkerArtifactReceiveBeginInput): Promise<WorkerArtifactReceiveBeginResult> {
        this.#assertReady();
        return await this.#protocolClient.beginArtifactReceive(input);
    }

    async writeArtifactReceive(input: WorkerArtifactReceiveWriteInput): Promise<WorkerArtifactReceiveWriteResult> {
        this.#assertReady();
        return await this.#protocolClient.writeArtifactReceive(input);
    }

    async finishArtifactReceive(receiveId: string): Promise<WorkerArtifactReceiveFinishResult> {
        this.#assertReady();
        return await this.#protocolClient.finishArtifactReceive(receiveId);
    }

    async abortArtifactReceive(receiveId: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.abortArtifactReceive(receiveId);
    }

    async start(workspacePath?: WorkspacePath | string): Promise<InstanceSnapshot> {
        return await this.#start(workspacePath);
    }

    async startInteractive(
        workspacePath: WorkerCommandInteractiveSession | WorkspacePath | string | undefined,
        interactiveSession?: WorkerCommandInteractiveSession
    ): Promise<InstanceSnapshot> {
        return await this.#start(
            isInteractiveSession(workspacePath) ? undefined : workspacePath,
            isInteractiveSession(workspacePath) ? workspacePath : interactiveSession
        );
    }

    async #start(
        workspacePath?: WorkspacePath | string,
        interactiveSession?: WorkerCommandInteractiveSession
    ): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged") {
            throw createError({
                code: errorCodes.reverseSelfManagedOffline,
                details: { instance: this.#config.name },
                message: `Instance ${this.#config.name} is self-managed and must be started on the remote machine.`,
                retryable: true
            });
        }

        const resolvedWorkspacePath = workspacePath ?? this.#config.defaultWorkspace;

        if (resolvedWorkspacePath === undefined) {
            throw createError({
                code: errorCodes.coreWorkerStartFailed,
                message: `Instance ${this.#config.name} requires a workspace to start.`,
                retryable: false,
                details: { instanceName: this.#config.name }
            });
        }

        this.#connection.setWorkspacePath(resolvedWorkspacePath);
        await this.#applyStateUpdate({
            connectionState: "disconnected",
            daemonState: "starting",
            lastErrorCode: undefined
        });

        try {
            const startResult = await this.#requireCommandClient().start(resolvedWorkspacePath, interactiveSession);

            if (startResult.exitCode !== 0) {
                throw createError({
                    code: errorCodes.coreWorkerStartFailed,
                    message: `Worker start failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: toJsonDetails(withInstanceDetails(startResult.details, this.#config.name))
                });
            }
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStartFailed,
                `Worker start failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "stopped",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStartFailed)
            });
            throw wrappedError;
        }

        await this.#applyStateUpdate({ connectionState: "connecting" });
        return await this.#connection.connectStarted();
    }

    async stop(): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged") {
            return await this.#connection.stopSelfManaged();
        }

        let stopErrorCode: string | undefined;

        try {
            const result = await this.#requireCommandClient().stop();

            if (result.exitCode !== 0) {
                throw createError({
                    code: errorCodes.coreWorkerStopFailed,
                    message: `Worker stop failed for instance ${this.#config.name}.`,
                    retryable: false,
                    details: toJsonDetails(withInstanceDetails(result.details, this.#config.name))
                });
            }
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStopFailed,
                `Worker stop failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            stopErrorCode = getErrorCode(error, errorCodes.coreWorkerStopFailed);
            await this.#applyStateUpdate({
                connectionState: "disconnected",
                daemonState: "stopping",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStopFailed)
            });
            throw wrappedError;
        } finally {
            this.#connection.closeBridge();
            this.#connection.clearHandshake();
        }

        await this.#appendEvent("instance.stopped");
        await this.#applyStateUpdate({
            daemonState: "stopped",
            lastErrorCode: stopErrorCode
        });
        return await this.#applyStateUpdate({
            connectionState: "disconnected",
            lastErrorCode: undefined
        });
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        if (this.#config.managementMode === "selfManaged") {
            if (!this.#connection.connected) {
                this.#connection.markReverseOffline();
                this.#connection.clearHandshake();
                return await this.#applyStateUpdate({
                    connectionState: "disconnected",
                    daemonState: "stopped",
                    lastErrorCode: undefined,
                    pid: undefined
                });
            }

            return await this.#connection.refreshRunningStatus(undefined);
        }

        const status = await this.#readWorkerStatus();

        if (status.workspacePath !== undefined) {
            this.#connection.setWorkspacePath(status.workspacePath);
        }

        switch (status.daemonState) {
            case "stopped":
            case "stale":
                this.#connection.closeBridge();
                this.#connection.clearHandshake();
                return await this.#applyStateUpdate({
                    connectionState: "disconnected",
                    daemonState: status.daemonState,
                    lastErrorCode: undefined,
                    pid: status.pid
                });
            case "running":
                return await this.#connection.refreshRunningStatus(status.pid);
            default:
                return await this.#applyStateUpdate({
                    connectionState: "failed",
                    daemonState: "failed",
                    lastErrorCode: errorCodes.coreWorkerStatusFailed,
                    pid: status.pid
                });
        }
    }

    #assertReady(): void {
        if (this.snapshot().ready) {
            return;
        }
        throw createError({
            code: errorCodes.coreInstanceNotReady,
            message: `Instance ${this.#config.name} is not ready.`,
            retryable: false,
            details: { instanceName: this.#config.name }
        });
    }

    async callTool(toolName: string, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        return await this.#tool.call(toolName, input, context, signal);
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        return await this.#tool.listApprovals();
    }

    async getApproval(approvalId: string): Promise<ApprovalRequest> {
        return await this.#tool.getApproval(approvalId);
    }

    async decideApproval(
        approvalId: string,
        input: { decision: ApprovalDecision["decision"]; decidedBy: ApprovalDecision["decidedBy"]; policyPatch?: JsonValue; reason?: string; remember?: boolean }
    ): Promise<ApprovalRequest> {
        return await this.#tool.decideApproval(approvalId, input);
    }

    async readLogs(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        return await this.#tool.readLogs(query);
    }

    async readToolCalls(query: ToolCallQuery = {}): Promise<ToolCallRecord[]> {
        return await this.#tool.readToolCalls(query);
    }

    reconfigure(input: {
        approvalPolicy?: ResolvedWorkerInstanceConfig["approvalPolicy"];
        defaultWorkspace?: WorkspacePath;
        effectiveSecurityMode: ResolvedWorkerInstanceConfig["effectiveSecurityMode"];
        env?: NodeJS.ProcessEnv;
    }): void {
        this.#config.approvalPolicy = input.approvalPolicy;
        this.#config.defaultWorkspace = input.defaultWorkspace;
        this.#config.effectiveSecurityMode = input.effectiveSecurityMode;
        this.#config.env = input.env;
        this.#approvalManager.setPolicy(input.approvalPolicy);
    }

    async appendMcpSessionOpened(sessionId: string): Promise<void> {
        await this.#appendEvent("mcp.sessionOpened", toEventData({ sessionId }));
    }

    async appendMcpSessionClosed(sessionId: string): Promise<void> {
        await this.#appendEvent("mcp.sessionClosed", toEventData({ sessionId }));
        await this.releaseToolSession(sessionId);
    }

    async releaseToolSession(sessionId: string): Promise<void> {
        if (this.snapshot().ready) {
            await this.#protocolClient.closeToolSession(sessionId).catch(() => undefined);
        }
    }

    async appendMcpToolCalled(toolName: string, context: { requestId?: string; sessionId?: string }): Promise<void> {
        await this.#appendEvent(
            "mcp.toolCalled",
            toEventData({
                requestId: context.requestId,
                sessionId: context.sessionId,
                source: "mcp",
                toolName
            })
        );
    }

    subscribe(fromSeq = 1): EventStreamGap | EventStreamSlice {
        return this.#eventBuffer.readFrom(fromSeq);
    }

    async close(): Promise<void> {
        await this.#connection.close();
    }

    get handshake(): WorkerHandshakeResult | undefined {
        return this.#connection.handshake;
    }

    get workspacePath(): WorkspacePath | undefined {
        return this.#connection.workspacePath;
    }

    async reconnectRpc(): Promise<InstanceSnapshot> {
        return await this.#connection.reconnectRpc();
    }

    #requireCommandClient(): WorkerCommandClient {
        if (this.#commandClient !== undefined) {
            return this.#commandClient;
        }

        throw createError({
            code: errorCodes.coreProviderFailed,
            details: { instance: this.#config.name },
            message: `Instance ${this.#config.name} does not have a controller-managed command transport.`,
            retryable: false
        });
    }

    async #readWorkerStatus(): Promise<{
        daemonState: "running" | "stale" | "stopped";
        pid?: number;
        workspacePath?: string;
    }> {
        let result: Awaited<ReturnType<WorkerCommandClient["status"]>>;

        try {
            result = await this.#requireCommandClient().status();
        } catch (error) {
            const wrappedError = wrapWorkerCommandError(
                error,
                errorCodes.coreWorkerStatusFailed,
                `Worker status failed for instance ${this.#config.name}.`,
                this.#config.name
            );
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(wrappedError, errorCodes.coreWorkerStatusFailed)
            });
            throw wrappedError;
        }

        if (result.exitCode !== 0) {
            const error = createError({
                code: errorCodes.coreWorkerStatusFailed,
                message: `Worker status failed for instance ${this.#config.name}.`,
                retryable: false,
                details: toJsonDetails(withInstanceDetails(result.details, this.#config.name))
            });
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: error.code
            });
            throw error;
        }

        try {
            return parseWorkerStatus(result.stdout, this.#config.name);
        } catch (error) {
            await this.#applyStateUpdate({
                connectionState: "failed",
                daemonState: "failed",
                lastErrorCode: getErrorCode(error, errorCodes.coreWorkerStatusFailed)
            });
            throw error;
        }
    }

    async #appendEvent(type: InstanceEventInput["type"], data?: JsonValue) {
        const event = await this.#eventBuffer.append({
            at: new Date().toISOString(),
            data,
            type
        });
        this.#stateMachine.apply({ lastSeq: event.seq });
        return event;
    }

    async #applyStateUpdate(update: InstanceStateUpdate): Promise<InstanceSnapshot> {
        const previous = this.snapshot();
        const next = this.#stateMachine.apply(update);

        if (previous.daemonState !== next.daemonState || normalizeLifecycleStatus(previous.status) !== normalizeLifecycleStatus(next.status)) {
            await this.#appendEvent("instance.statusChanged", createStatusChangedEventData(previous, next));
        }

        if (previous.connectionState !== next.connectionState) {
            await this.#appendEvent("instance.connectionChanged", createConnectionChangedEventData(previous, next));
        }

        if (previous.ready !== next.ready) {
            await this.#appendEvent("instance.readyChanged", createReadyChangedEventData(previous, next));
        }

        return this.snapshot();
    }
}

function isInteractiveSession(value: unknown): value is WorkerCommandInteractiveSession {
    return typeof value === "object" && value !== null && "readInput" in value && "writeOutput" in value;
}
