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
    type ReverseTransport
} from "@portable-devshell/shared";

import type { ApprovalManager } from "../../approval/ApprovalManager.js";
import type { AuditDatabase } from "../../audit/AuditDatabase.js";
import type { InstanceEventInput, InstanceEventStreamGap, InstanceEventStreamSlice } from "../../instance/event/InstanceEventBuffer.js";
import type { LogQuery } from "../../log/LogQuery.js";
import type { InstanceLogEntry } from "../../log/store/LogStoreInstance.js";
import type { WorkerCommandClient } from "../command/WorkerCommandClient.js";
import type { WorkerCommandInteractiveSession } from "../command/WorkerCommandTransport.js";
import type {
    WorkerArtifactDirectPushInput,
    WorkerArtifactDirectPushResult,
    WorkerArtifactDirectReceiveOpenInput,
    WorkerArtifactDirectReceiveOpenResult,
    WorkerArtifactPayloadOpenInput,
    WorkerArtifactPayloadOpenResult,
    WorkerArtifactPayloadReadInput,
    WorkerArtifactPayloadReadResult,
    WorkerArtifactReceiveBeginInput,
    WorkerArtifactReceiveBeginResult,
    WorkerArtifactReceiveFinishResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult,
    WorkerHandshakeResult,
    WorkerProtocolClient
} from "../protocol/WorkerProtocolClient.js";
import type { WorkerRpcBridge } from "../rpc/WorkerRpcBridge.js";
import type { Channel } from "@portable-devshell/shared";
import type { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import type { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import type { WorkerToolCallScheduler } from "../tool/WorkerToolCallScheduler.js";
import type {
    WorkerTerminalAttachResult,
    WorkerTerminalClient,
    WorkerTerminalDescriptor,
    WorkerTerminalIdentity,
    WorkerTerminalNotification,
    WorkerTerminalOpenInput
} from "../terminal/WorkerTerminalClient.js";
import type { WorkerRpcError } from "../rpc/WorkerRpcError.js";
import type { AuditToolCallHistory } from "../../audit/tool/AuditToolCallHistory.js";
import type { InstanceStateMachine } from "../../instance/state/InstanceStateMachine.js";
import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";
import type { InstanceEventBuffer } from "../../instance/event/InstanceEventBuffer.js";
import type { LogStoreInstance } from "../../log/store/LogStoreInstance.js";
import type { ResolvedWorkerInstanceConfig } from "./WorkerInstanceConfig.js";
import { WorkerInstanceTool } from "./WorkerInstanceTool.js";
import { WorkerInstanceConnection } from "./WorkerInstanceConnection.js";
import { WorkerInstanceLifecycle } from "./WorkerInstanceLifecycle.js";
import { WorkerInstanceArtifact } from "./WorkerInstanceArtifact.js";
import { WorkerInstanceAudit } from "./WorkerInstanceAudit.js";
import { WorkerInstanceState } from "./WorkerInstanceState.js";

interface WorkerInstanceDependencies {
    approvalManager: ApprovalManager;
    auditDatabase: AuditDatabase;
    catalog: WorkerToolCatalog;
    commandClient?: WorkerCommandClient;
    config: ResolvedWorkerInstanceConfig;
    eventBuffer: InstanceEventBuffer;
    logStore: LogStoreInstance;
    protocolClient: WorkerProtocolClient;
    rpcBridge: WorkerRpcBridge;
    stateMachine: InstanceStateMachine;
    terminalClient: WorkerTerminalClient;
    toolCallAssociationProvider?: (context: ToolCallContext) => ToolCallAssociation | undefined;
    toolCallHistory: AuditToolCallHistory;
    toolCallScheduler: WorkerToolCallScheduler;
    toolInvoker: WorkerToolInvoker;
}

export class WorkerInstance {
    readonly #approvalManager: ApprovalManager;
    readonly #artifact: WorkerInstanceArtifact;
    readonly #audit: WorkerInstanceAudit;
    readonly #catalog: WorkerToolCatalog;
    readonly #config: ResolvedWorkerInstanceConfig;
    readonly #connection: WorkerInstanceConnection;
    readonly #lifecycle: WorkerInstanceLifecycle;
    readonly #protocolClient: WorkerProtocolClient;
    readonly #state: WorkerInstanceState;
    readonly #terminalClient: WorkerTerminalClient;
    readonly #tool: WorkerInstanceTool;
    readonly #toolInvoker: WorkerToolInvoker;

    constructor(dependencies: WorkerInstanceDependencies) {
        this.#approvalManager = dependencies.approvalManager;
        this.#catalog = dependencies.catalog;
        this.#config = dependencies.config;
        this.#protocolClient = dependencies.protocolClient;
        this.#state = new WorkerInstanceState({
            config: this.#config,
            eventBuffer: dependencies.eventBuffer,
            stateMachine: dependencies.stateMachine
        });
        this.#connection = new WorkerInstanceConnection({
            appendEvent: (type, data) => this.#state.appendEvent(type, data),
            applyStateUpdate: (update) => this.#state.apply(update, this.#connection.snapshotReverse()),
            catalog: this.#catalog,
            config: this.#config,
            protocolClient: dependencies.protocolClient,
            rpcBridge: dependencies.rpcBridge,
            snapshot: () => this.snapshot()
        });
        this.#terminalClient = dependencies.terminalClient;
        this.#lifecycle = new WorkerInstanceLifecycle({
            appendEvent: (type) => this.#state.appendEvent(type),
            applyStateUpdate: (update) => this.#state.apply(update, this.#connection.snapshotReverse()),
            commandClient: dependencies.commandClient,
            config: this.#config,
            connection: this.#connection
        });
        this.#artifact = new WorkerInstanceArtifact({
            assertReady: () => this.#assertReady(),
            protocolClient: dependencies.protocolClient
        });
        this.#audit = new WorkerInstanceAudit({
            appendEvent: (type, data) => this.#state.appendEvent(type, data),
            auditDatabase: dependencies.auditDatabase,
            isReady: () => this.snapshot().ready,
            protocolClient: dependencies.protocolClient
        });
        this.#tool = new WorkerInstanceTool({
            approvalManager: this.#approvalManager,
            appendEvent: (type, data) => this.#state.appendEvent(type, data),
            assertReady: () => this.#assertReady(),
            instanceName: this.#config.name,
            logStore: dependencies.logStore,
            toolCallAssociationProvider: dependencies.toolCallAssociationProvider,
            toolCallHistory: dependencies.toolCallHistory,
            toolCallScheduler: dependencies.toolCallScheduler,
            toolInvoker: dependencies.toolInvoker
        });
        this.#toolInvoker = dependencies.toolInvoker;
    }

    snapshot(): InstanceSnapshot {
        return this.#state.snapshot(this.#connection.snapshotReverse());
    }

    get managementMode(): ResolvedWorkerInstanceConfig["managementMode"] {
        return this.#config.managementMode;
    }

    async setReverseEnrollmentState(enrollmentState: ReverseEnrollmentState): Promise<InstanceSnapshot> {
        return await this.#connection.setReverseEnrollmentState(enrollmentState);
    }

    async acceptReverseChannel(
        channel: Channel,
        input: { connectedAt?: string; generation: number; transport: ReverseTransport }
    ): Promise<InstanceSnapshot> {
        return await this.#connection.acceptReverseChannel(channel, input);
    }


    async openTerminal(input: WorkerTerminalOpenInput): Promise<WorkerTerminalDescriptor> {
        return await this.#terminalClient.open(input);
    }

    async prepareWorkspace(workspace: string): Promise<Awaited<ReturnType<WorkerProtocolClient["prepareWorkspace"]>>> {
        this.#assertReady();
        return await this.#protocolClient.prepareWorkspace(workspace);
    }

    async readAlerts(workspace: string): Promise<Awaited<ReturnType<WorkerProtocolClient["readAlerts"]>>> {
        this.#assertReady();
        return await this.#protocolClient.readAlerts(workspace, this.#config.alerts);
    }

    async touchAlerts(workspace: string): Promise<void> {
        this.#assertReady();
        await this.#protocolClient.touchAlerts(workspace, this.#config.alerts);
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
        input: WorkerTerminalIdentity & { data: string }
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return await this.#terminalClient.write(input);
    }

    async resizeTerminal(
        input: WorkerTerminalIdentity & { cols: number; rows: number }
    ): Promise<WorkerTerminalIdentity & { accepted: boolean }> {
        return await this.#terminalClient.resize(input);
    }

    async killTerminal(input: WorkerTerminalIdentity): Promise<WorkerTerminalDescriptor> {
        return await this.#terminalClient.kill(input);
    }

    async listTerminals(): Promise<WorkerTerminalDescriptor[]> {
        return await this.#terminalClient.list();
    }

    onTerminalNotification(
        listener: (notification: WorkerTerminalNotification) => void
    ): () => void {
        return this.#terminalClient.onNotification(listener);
    }

    onRpcConnected(listener: () => void): () => void {
        return this.#terminalClient.onConnected(listener);
    }

    onRpcDisconnected(listener: (error: WorkerRpcError) => void): () => void {
        return this.#terminalClient.onDisconnected(listener);
    }

    async appendControlEvent(type: InstanceEventInput["type"], data?: JsonValue) {
        return await this.#state.appendEvent(type, data);
    }

    listTools() {
        return this.#catalog.listTools();
    }

    hasToolSchemaCache(): boolean {
        return this.#catalog.hasSchema();
    }

    async openArtifactPayload(input: WorkerArtifactPayloadOpenInput): Promise<WorkerArtifactPayloadOpenResult> {
        return await this.#artifact.openPayload(input);
    }

    async readArtifactPayload(input: WorkerArtifactPayloadReadInput): Promise<WorkerArtifactPayloadReadResult> {
        return await this.#artifact.readPayload(input);
    }

    async closeArtifactPayload(payloadId: string): Promise<void> {
        await this.#artifact.closePayload(payloadId);
    }

    async beginArtifactReceive(input: WorkerArtifactReceiveBeginInput): Promise<WorkerArtifactReceiveBeginResult> {
        return await this.#artifact.beginReceive(input);
    }

    async writeArtifactReceive(input: WorkerArtifactReceiveWriteInput): Promise<WorkerArtifactReceiveWriteResult> {
        return await this.#artifact.writeReceive(input);
    }

    async finishArtifactReceive(receiveId: string): Promise<WorkerArtifactReceiveFinishResult> {
        return await this.#artifact.finishReceive(receiveId);
    }

    async abortArtifactReceive(receiveId: string): Promise<void> {
        await this.#artifact.abortReceive(receiveId);
    }

    async openArtifactDirectReceive(
        input: WorkerArtifactDirectReceiveOpenInput
    ): Promise<WorkerArtifactDirectReceiveOpenResult> {
        return await this.#artifact.openDirectReceive(input);
    }

    async closeArtifactDirectReceive(receiverId: string): Promise<void> {
        await this.#artifact.closeDirectReceive(receiverId);
    }

    async pushArtifactPayloadDirect(
        input: WorkerArtifactDirectPushInput
    ): Promise<WorkerArtifactDirectPushResult> {
        return await this.#artifact.pushPayloadDirect(input);
    }

    async start(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.start();
    }

    async startInteractive(interactiveSession?: WorkerCommandInteractiveSession): Promise<InstanceSnapshot> {
        return await this.#lifecycle.startInteractive(interactiveSession);
    }

    async stop(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.stop();
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.refreshStatus();
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>
    ): Promise<JsonValue> {
        return await this.#tool.call(toolName, input, context, signal, transformResult);
    }

    async observeTmuxTask(taskId: string, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        this.#assertReady();
        const listed = await this.#toolInvoker.invoke("tmux_list", {}, context, signal);
        const active = findTmuxTask(listed, taskId);
        if (active !== undefined) return { task: active };
        return await this.#toolInvoker.invoke("tmux_read", { task: taskId, line: 0 }, context, signal);
    }

    async auditToolCall<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string) => Promise<T>,
        signal?: AbortSignal
    ): Promise<T> {
        return await this.#tool.auditToolCall(toolName, input, context, operation, signal);
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

    async reconfigure(input: {
        alerts?: ResolvedWorkerInstanceConfig["alerts"];
        approvalPolicy?: ResolvedWorkerInstanceConfig["approvalPolicy"];
        effectiveSecurityMode: ResolvedWorkerInstanceConfig["effectiveSecurityMode"];
        env?: NodeJS.ProcessEnv;
    }): Promise<void> {
        this.#config.alerts = input.alerts;
        this.#config.approvalPolicy = input.approvalPolicy;
        this.#config.effectiveSecurityMode = input.effectiveSecurityMode;
        this.#config.env = input.env;
        this.#approvalManager.setPolicy(input.approvalPolicy);
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

    async appendMcpToolCalled(toolName: string, context: { requestId?: string; ctxId?: string }): Promise<void> {
        await this.#audit.appendMcpToolCalled(toolName, context);
    }

    subscribe(fromSeq = 1): InstanceEventStreamGap | InstanceEventStreamSlice {
        return this.#state.subscribe(fromSeq);
    }

    async close(): Promise<void> {
        try {
            await this.#lifecycle.closeConnection();
        } finally {
            this.#audit.close();
        }
    }

    get handshake(): WorkerHandshakeResult | undefined {
        return this.#connection.handshake;
    }

    async reconnectRpc(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.reconnectRpc();
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
}

function findTmuxTask(result: JsonValue, taskId: string): Record<string, JsonValue> | undefined {
    if (typeof result !== "object" || result === null || Array.isArray(result) || !Array.isArray(result.panes)) {
        return undefined;
    }
    for (const pane of result.panes) {
        if (typeof pane !== "object" || pane === null || Array.isArray(pane)) continue;
        const task = pane.task;
        if (typeof task !== "object" || task === null || Array.isArray(task)) continue;
        if (task.id === taskId) return task;
    }
    return undefined;
}
