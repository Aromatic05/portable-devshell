import {
    ProtocolControlRpcClient,
    type ApprovalDecision,
    type ApprovalRequest,
    type ArtifactShareResult,
    type ArtifactShareRevokeResult,
    type ArtifactTransferRecord,
    type ArtifactTransferResult,
    type ControlRpcInstanceListEntry,
    type ControlRpcInstanceLogEntry,
    type ControlRpcInstanceSnapshotEnvelope,
    type InstanceCreateDraft,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type InstanceSnapshot,
    type JsonValue,
    type OAuthApprovalRequest,
    type ReverseDeviceCodeResult,
    type TodoRpcEnvelope,
    type ToolCallQuery,
    type ToolCallRecord
} from "@portable-devshell/shared";

import {
    createTuiControlConnection,
    type TuiControlConnection,
    type TuiControlConnectionOptions
} from "./TuiControlConnection.js";
import { TuiControlStream } from "./TuiControlStream.js";

export type TuiControlSnapshotEnvelope = ControlRpcInstanceSnapshotEnvelope;
export type TuiControlListInstanceEntry = ControlRpcInstanceListEntry;
export type TuiControlLogEntry = ControlRpcInstanceLogEntry;

export interface TuiControlStartOptions {
    relay?: {
        onOutput(chunk: string): void;
        onRequestId?(requestId: string): void;
    };
    workspacePath?: string;
}

export interface TuiControlDecisionOptions {
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

export interface TuiControlClientLike {
    applyConfig(): Promise<JsonValue>;
    createInstance(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
    createReverseDeviceCode(instance: string): Promise<ReverseDeviceCodeResult>;
    deleteInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    disableInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    enableInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    getConfigView(): Promise<Record<string, JsonValue>>;
    getMcpStatus(): Promise<Record<string, JsonValue>>;
    getInstanceCreateSchema(): Promise<InstanceCreateSchema>;
    getApproval(instance: string, approvalId: string): Promise<ApprovalRequest>;
    getSnapshot(instance: string): Promise<TuiControlSnapshotEnvelope>;
    getTodo(instance: string): Promise<TodoRpcEnvelope>;
    listApprovals(instance: string): Promise<ApprovalRequest[]>;
    listArtifactShares?(): Promise<ArtifactShareResult[]>;
    listArtifactTransfers?(): Promise<ArtifactTransferRecord[]>;
    revokeArtifactShare?(shareId: string): Promise<ArtifactShareRevokeResult>;
    cancelArtifactTransfer?(transferId: string): Promise<ArtifactTransferResult>;
    listInstances(): Promise<TuiControlListInstanceEntry[]>;
    listOAuthApprovals?(): Promise<OAuthApprovalRequest[]>;
    ping(): Promise<{ pong: boolean }>;
    restartControl(): Promise<Record<string, JsonValue>>;
    readLogs(instance: string, params?: { fromSeq?: number; limit?: number }): Promise<TuiControlLogEntry[]>;
    readToolCalls(instance: string, params?: ToolCallQuery): Promise<ToolCallRecord[]>;
    refreshStatus(instance: string): Promise<TuiControlSnapshotEnvelope>;
    startInstance(instance: string, options?: TuiControlStartOptions): Promise<InstanceSnapshot>;
    stopInstance(instance: string): Promise<InstanceSnapshot>;
    updateInstanceConfig(instanceConfig: JsonValue): Promise<Record<string, JsonValue>>;
    updateMcpConfig(mcpConfig: JsonValue): Promise<Record<string, JsonValue>>;
    validateConfigDraft(draft: JsonValue): Promise<Record<string, JsonValue>>;
    validateInstanceCreateDraft(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
    callTool(instance: string, toolName: string, input: JsonValue): Promise<JsonValue>;
    decideApproval(
        instance: string,
        approvalId: string,
        decision: ApprovalDecision["decision"],
        options?: TuiControlDecisionOptions
    ): Promise<ApprovalRequest>;
    decideOAuthApproval?(approvalId: string, decision: "approve" | "deny"): Promise<OAuthApprovalRequest>;
    subscribe(instance: string, fromSeq: number): Promise<TuiControlStream>;
}

export class TuiControlClient extends ProtocolControlRpcClient<TuiControlConnection> implements TuiControlClientLike {
    constructor(options: TuiControlConnectionOptions = {}) {
        super(() => createTuiControlConnection(options));
    }

    async startInstance(instance: string, options: TuiControlStartOptions = {}): Promise<InstanceSnapshot> {
        const params = options.workspacePath === undefined ? undefined : { workspacePath: options.workspacePath };
        return await this.startInstanceRequest(instance, params, options.relay);
    }

    async subscribe(instance: string, fromSeq: number): Promise<TuiControlStream> {
        const { connection, events } = await this.openSubscription("instance.subscribe", instance, fromSeq);
        return new TuiControlStream(connection, events);
    }
}
