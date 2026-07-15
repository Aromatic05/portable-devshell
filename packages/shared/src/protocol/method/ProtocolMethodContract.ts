import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput
} from "../../dto/artifact/DtoArtifact.js";
import type { InstanceCreateDraft, InstanceCreateResult, InstanceCreateSchema, InstanceCreateSummary } from "../../dto/instance/DtoInstanceCreate.js";
import type { InstanceEvent } from "../../dto/instance/DtoInstanceEvent.js";
import type { InstanceSnapshot } from "../../dto/instance/DtoInstanceSnapshot.js";
import type { TodoRpcEnvelope } from "../../dto/instance/DtoTodo.js";
import type { OAuthApprovalDecision, OAuthApprovalRequest } from "../../dto/oauth/DtoOAuthApproval.js";
import type { ReverseDeviceCodeResult } from "../../dto/reverse/DtoReverseConnection.js";
import type { ApprovalDecisionValue, ApprovalRequest } from "../../dto/tool/DtoToolApproval.js";
import type { ToolCallQuery, ToolCallRecord } from "../../dto/tool/DtoToolCallRecord.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { ControlTargetControl, ControlTargetInstance } from "../envelope/ProtocolEnvelopeTarget.js";

export type ControlRpcJsonObject = { [key: string]: JsonValue };
export type ControlRpcMethodSpec<TTarget, TParams, TResult> = { params: TParams; result: TResult; target: TTarget };

export interface ControlRpcInstanceSnapshotEnvelope { lastSeq: number; snapshot: InstanceSnapshot }
export interface ControlRpcInstanceListEntry { mcpEnabled: boolean; name: string; snapshot: InstanceSnapshot }
export interface ControlRpcInstanceLogEntry {
    at: string;
    callId?: string;
    ctxId?: string;
    instanceName: string;
    message: string;
    requestId?: string;
    seq: number;
    source?: "cli" | "mcp" | "tui";
    stream: "stderr" | "stdout";
    toolName?: string;
}
export interface ControlRpcSubscriptionResult { events: InstanceEvent[]; lastSeq: number }
export type ControlRpcArtifactShareParams = ArtifactShareInput & { defaultInstance: string };
export type ControlRpcArtifactTransferStartParams = ArtifactTransferStartInput & { defaultInstance: string };
export interface ControlRpcApprovalDecisionParams {
    approvalId: string;
    decision: ApprovalDecisionValue;
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

type Control<TParams, TResult> = ControlRpcMethodSpec<ControlTargetControl, TParams, TResult>;
type Instance<TParams, TResult> = ControlRpcMethodSpec<ControlTargetInstance, TParams, TResult>;

export interface ControlRpcMethodMap {
    "control.applyConfig": Control<undefined, JsonValue>;
    "control.artifact.cancelTransfer": Control<{ transferId: string }, ArtifactTransferResult>;
    "control.artifact.createShare": Control<ControlRpcArtifactShareParams, ArtifactShareResult>;
    "control.artifact.getTransfer": Control<{ transferId: string }, ArtifactTransferRecord>;
    "control.artifact.listShares": Control<undefined, ArtifactShareResult[]>;
    "control.artifact.listTransfers": Control<undefined, ArtifactTransferRecord[]>;
    "control.artifact.revokeShare": Control<{ shareId: string }, ArtifactShareRevokeResult>;
    "control.artifact.startTransfer": Control<ControlRpcArtifactTransferStartParams, ArtifactTransferResult>;
    "control.createInstance": Control<InstanceCreateDraft, InstanceCreateResult>;
    "control.createReverseDeviceCode": Control<{ instance: string }, ReverseDeviceCodeResult>;
    "control.decideOAuthApproval": Control<{ approvalId: string; decision: OAuthApprovalDecision }, OAuthApprovalRequest>;
    "control.deleteInstance": Control<{ instanceName: string }, ControlRpcJsonObject>;
    "control.disableInstance": Control<{ instanceName: string }, ControlRpcJsonObject>;
    "control.enableInstance": Control<{ instanceName: string }, ControlRpcJsonObject>;
    "control.getConfigView": Control<undefined, ControlRpcJsonObject>;
    "control.getInstanceCreateSchema": Control<undefined, InstanceCreateSchema>;
    "control.getMcpStatus": Control<undefined, ControlRpcJsonObject>;
    "control.identifyClient": Control<{ clientKind: "cli" | "tui" }, { clientKind: "cli" | "tui"; ok: true }>;
    "control.listInstances": Control<undefined, ControlRpcInstanceListEntry[]>;
    "control.listOAuthApprovals": Control<undefined, OAuthApprovalRequest[]>;
    "control.ping": Control<undefined, { pong: true }>;
    "control.restart": Control<undefined, { accepted: true }>;
    "control.revokeReverseDeviceToken": Control<{ instance: string }, { instance: string; revoked: true }>;
    "control.rotateReverseDeviceToken": Control<{ instance: string }, { deviceToken: string; instance: string }>;
    "control.shutdown": Control<undefined, { accepted: true }>;
    "control.status": Control<undefined, { instanceCount: number; ok: true }>;
    "control.updateInstanceConfig": Control<JsonValue, ControlRpcJsonObject>;
    "control.updateMcpConfig": Control<JsonValue, ControlRpcJsonObject>;
    "control.validateConfigDraft": Control<JsonValue, ControlRpcJsonObject>;
    "control.validateInstanceCreateDraft": Control<InstanceCreateDraft, InstanceCreateSummary>;
    "instance.callTool": Instance<{ input: JsonValue; toolName: string }, JsonValue>;
    "instance.decideApproval": Instance<ControlRpcApprovalDecisionParams, ApprovalRequest>;
    "instance.getApproval": Instance<{ approvalId: string }, ApprovalRequest>;
    "instance.getSnapshot": Instance<undefined, ControlRpcInstanceSnapshotEnvelope>;
    "instance.listApprovals": Instance<undefined, ApprovalRequest[]>;
    "instance.readLogs": Instance<{ fromSeq?: number; limit?: number } | undefined, ControlRpcInstanceLogEntry[]>;
    "instance.readToolCalls": Instance<ToolCallQuery | undefined, ToolCallRecord[]>;
    "instance.refreshStatus": Instance<undefined, ControlRpcInstanceSnapshotEnvelope>;
    "instance.start": Instance<{ workspacePath?: string } | undefined, InstanceSnapshot>;
    "instance.stop": Instance<undefined, InstanceSnapshot>;
    "instance.subscribe": Instance<{ fromSeq: number }, ControlRpcSubscriptionResult>;
    "instance.todo.get": Instance<undefined, TodoRpcEnvelope>;
    "instance.todo.subscribe": Instance<{ fromSeq: number }, ControlRpcSubscriptionResult>;
}

export type ControlRpcMethod = keyof ControlRpcMethodMap;
export type ControlRpcParams<TMethod extends ControlRpcMethod> = ControlRpcMethodMap[TMethod]["params"];
export type ControlRpcResult<TMethod extends ControlRpcMethod> = ControlRpcMethodMap[TMethod]["result"];
export type ControlRpcTarget<TMethod extends ControlRpcMethod> = ControlRpcMethodMap[TMethod]["target"];
export type ControlRpcRequestArgs<TMethod extends ControlRpcMethod> = undefined extends ControlRpcParams<TMethod>
    ? [params?: Exclude<ControlRpcParams<TMethod>, undefined>]
    : [params: ControlRpcParams<TMethod>];
