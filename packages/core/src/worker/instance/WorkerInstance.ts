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

import type { ApprovalManager } from "../../approval/ApprovalManager.js";
import type { AuditDatabase } from "../../audit/AuditDatabase.js";
import type { InstanceEventInput, InstanceEventStreamGap, InstanceEventStreamSlice } from "../../instance/event/InstanceEventBuffer.js";
import type { LogQuery } from "../../log/LogQuery.js";
import type { InstanceLogEntry } from "../../log/store/LogStoreInstance.js";
import type { WorkerCommandClient } from "../command/WorkerCommandClient.js";
import type { WorkerCommandInteractiveSession } from "../command/WorkerCommandTransport.js";
import type {
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
import type { WorkerRpcChannel } from "../rpc/WorkerRpcChannel.js";
import type { WorkerToolCatalog } from "../tool/WorkerToolCatalog.js";
import type { WorkerToolInvoker } from "../tool/WorkerToolInvoker.js";
import type { WorkerToolCallScheduler } from "../tool/WorkerToolCallScheduler.js";
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
    toolCallAssociationProvider?: () => ToolCallAssociation | undefined;
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
    readonly #state: WorkerInstanceState;
    readonly #tool: WorkerInstanceTool;

    constructor(dependencies: WorkerInstanceDependencies) {
        this.#approvalManager = dependencies.approvalManager;
        this.#catalog = dependencies.catalog;
        this.#config = dependencies.config;
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
        channel: WorkerRpcChannel,
        input: { connectedAt?: string; generation: number; transport: ReverseTransport }
    ): Promise<InstanceSnapshot> {
        return await this.#connection.acceptReverseChannel(channel, input);
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

    async start(workspacePath?: WorkspacePath | string): Promise<InstanceSnapshot> {
        return await this.#lifecycle.start(workspacePath);
    }

    async startInteractive(
        workspacePath: WorkerCommandInteractiveSession | WorkspacePath | string | undefined,
        interactiveSession?: WorkerCommandInteractiveSession
    ): Promise<InstanceSnapshot> {
        return await this.#lifecycle.startInteractive(workspacePath, interactiveSession);
    }

    async stop(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.stop();
    }

    async refreshStatus(): Promise<InstanceSnapshot> {
        return await this.#lifecycle.refreshStatus();
    }

    async callTool(toolName: string, input: JsonValue, context: ToolCallContext, signal?: AbortSignal): Promise<JsonValue> {
        return await this.#tool.call(toolName, input, context, signal);
    }

    async auditToolCall<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: () => Promise<T>,
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
            await this.#connection.close();
        } finally {
            this.#audit.close();
        }
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
