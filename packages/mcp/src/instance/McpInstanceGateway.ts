import type {
    ArtifactShareInput,
    ArtifactTransferCancelInput,
    ArtifactTransferLookupInput,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult
} from "@portable-devshell/shared";
import type {
    ApprovalRequest,
    ContextMessageReadResult,
    ContextMessageRecord,
    GoalContinuationInput,
    GoalManageInput,
    GoalSnapshot,
    InstanceEvent,
    JsonValue,
    TodoReadInput,
    TodoTaskControlAction,
    ToolCallContext,
    ToolCallRecord,
    ToolDefinition,
    WaitCreateInput,
    WaitRecord
} from "@portable-devshell/shared";
import type { McpEndpointEnvironmentHandshake } from "../endpoint/McpEndpointPort.js";

export interface McpSshInstanceCreateInput {
    host: string;
    identityFile?: string;
    name: string;
    port?: number;
    user?: string;
}

export interface McpWorkspaceEventSlice {
    events: InstanceEvent[];
    gap: boolean;
    lastSeq: number;
}

export interface McpInstanceGateway {
    appendMcpToolCalled(instance: string, toolName: string, context: { requestId?: string; ctxId?: string }): Promise<void>;
    assertReady(instance: string): void;
    auditToolCall<T extends JsonValue>(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string) => Promise<T>,
        signal?: AbortSignal
    ): Promise<T>;
    callTool(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>,
        invocationInput?: JsonValue,
    ): Promise<JsonValue>;
    invokeToolInternal?(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    closeToolSession?(sessionId: string): Promise<void>;
    createSshInstance(sourceInstance: string, input: McpSshInstanceCreateInput): Promise<JsonValue>;
    environment(instance: string): McpEndpointEnvironmentHandshake | undefined;
    listInstances(): Promise<JsonValue>;
    goalContinuation?(instance: string, input: GoalContinuationInput, ctxId: string): Promise<JsonValue>;
    manageGoal?(instance: string, input: GoalManageInput, ctxId: string): Promise<GoalSnapshot | undefined>;
    readGoal?(instance: string, ctxId: string): Promise<GoalSnapshot | undefined>;
    touchGoal?(instance: string, ctxId: string): Promise<void>;
    createWait?(instance: string, input: WaitCreateInput): Promise<WaitRecord>;
    cancelWait?(instance: string, waitId: string): Promise<WaitRecord>;
    claimWaitRecovery?(instance: string, waitId: string, claimId: string): Promise<WaitRecord>;
    completeWaitRecovery?(instance: string, waitId: string, claimId: string): Promise<WaitRecord>;
    markWaitRecoveryAttempted?(instance: string, waitId: string, claimId: string): Promise<WaitRecord>;
    markWaitRecoverySent?(instance: string, waitId: string, claimId: string): Promise<WaitRecord>;
    detachWait?(instance: string, waitId: string): Promise<WaitRecord>;
    dismissWaitRecovery?(instance: string, waitId: string, recoveryMessageId: string): Promise<WaitRecord>;
    reattachWait?(instance: string, waitId: string, ownerCallId?: string): Promise<WaitRecord>;
    releaseWaitRecovery?(instance: string, waitId: string, claimId: string): Promise<WaitRecord>;
    rejectWaitRecovery?(instance: string, waitId: string, claimId: string): Promise<WaitRecord>;
    disableWaitRecovery?(instance: string, waitId: string): Promise<WaitRecord>;
    consumeWait?(instance: string, waitId: string): Promise<WaitRecord>;
    resolveWait?(instance: string, waitId: string, result?: JsonValue): Promise<WaitRecord>;
    waitForWait?(instance: string, waitId: string): Promise<WaitRecord>;
    listWaits?(instance: string): Promise<WaitRecord[]>;
    listApprovals?(instance: string): Promise<ApprovalRequest[]>;
    listPendingApprovals?(instance: string, ctxId?: string): Promise<ApprovalRequest[]>;
    decideApproval?(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<ApprovalRequest>;
    cancelApproval?(instance: string, approvalId: string, reason?: string): Promise<ApprovalRequest>;
    readToolCalls?(instance: string, ctxId: string, limit: number): Promise<ToolCallRecord[]>;
    hasActiveToolCalls?(instance: string, ctxId: string): boolean;
    readWorkspaceEvents?(instance: string, fromSeq: number): Promise<McpWorkspaceEventSlice>;
    controlTodo?(instance: string, taskId: string, action: TodoTaskControlAction, ctxId: string, expectedRevision?: number): Promise<JsonValue>;
    consumeContextMessages?(instance: string, ctxId: string, callId: string): Promise<ContextMessageReadResult>;
    failContextMessages?(instance: string, ctxId: string, reason: string): Promise<ContextMessageRecord[]>;
    readTodo(instance: string, input?: TodoReadInput): Promise<JsonValue>;
    listTools(instance: string): ToolDefinition[];
    observeTmuxTask?(
        instance: string,
        taskId: string,
        context: ToolCallContext,
        signal?: AbortSignal
    ): Promise<JsonValue>;
    prepareWorkspace(instance: string, workspace: string): Promise<{
        projectMemoryAgentFile: string;
        projectMemoryDirectory: string;
        projectMemoryPresent?: boolean;
        temporaryDirectory: string;
        workspace: string;
    }>;
    readAlerts(instance: string, workspace: string): Promise<{ advice: Array<{ code: string; text: string }> }>;
    releaseAlerts(instance: string, workspace: string): Promise<void>;
    connectInstance(instance: string, reference: string): Promise<JsonValue>;
    releaseInstanceReference?(instance: string, reference: string): Promise<void>;
    statusInstance(instance: string): Promise<JsonValue>;
    stopInstance(instance: string): Promise<JsonValue>;
    touchAlerts(instance: string, workspace: string): Promise<void>;
    touchTemporaryDirectory(instance: string, path: string): Promise<void>;
    writeTodo(instance: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue>;

    viewArtifactImage?(
        defaultInstance: string,
        input: ArtifactViewImageInput,
        signal?: AbortSignal
    ): Promise<ArtifactViewImageResult>;
    shareArtifact?(defaultInstance: string, input: ArtifactShareInput): Promise<JsonValue>;
    transferArtifact?(
        defaultInstance: string,
        input: ArtifactTransferStartInput | ArtifactTransferLookupInput | ArtifactTransferCancelInput
    ): Promise<JsonValue>;
}

export type McpInteractionGateway = McpInstanceGateway & Required<Pick<
    McpInstanceGateway,
    | "createWait"
    | "detachWait"
    | "consumeWait"
    | "resolveWait"
    | "waitForWait"
    | "listWaits"
    | "listApprovals"
    | "decideApproval"
>>;

export function isMcpInteractionGateway(
    gateway: McpInstanceGateway | undefined
): gateway is McpInteractionGateway {
    return gateway !== undefined &&
        gateway.createWait !== undefined &&
        gateway.detachWait !== undefined &&
        gateway.consumeWait !== undefined &&
        gateway.resolveWait !== undefined &&
        gateway.waitForWait !== undefined &&
        gateway.listWaits !== undefined &&
        gateway.listApprovals !== undefined &&
        gateway.decideApproval !== undefined;
}

export type McpWaitRecoveryGateway = McpInteractionGateway & Required<Pick<
    McpInstanceGateway,
    "claimWaitRecovery" | "completeWaitRecovery" | "disableWaitRecovery" | "dismissWaitRecovery" | "markWaitRecoveryAttempted" | "markWaitRecoverySent" | "rejectWaitRecovery" | "releaseWaitRecovery"
>>;

export function isMcpWaitRecoveryGateway(
    gateway: McpInstanceGateway | undefined
): gateway is McpWaitRecoveryGateway {
    return isMcpInteractionGateway(gateway) &&
        gateway.claimWaitRecovery !== undefined &&
        gateway.completeWaitRecovery !== undefined &&
        gateway.dismissWaitRecovery !== undefined &&
        gateway.markWaitRecoveryAttempted !== undefined &&
        gateway.markWaitRecoverySent !== undefined &&
        gateway.rejectWaitRecovery !== undefined &&
        gateway.disableWaitRecovery !== undefined &&
        gateway.releaseWaitRecovery !== undefined;
}

export type McpWaitTrackingGateway = McpInteractionGateway & Required<Pick<
    McpInstanceGateway,
    "cancelWait" | "reattachWait"
>>;

export function isMcpWaitTrackingGateway(
    gateway: McpInstanceGateway | undefined
): gateway is McpWaitTrackingGateway {
    return isMcpInteractionGateway(gateway) &&
        gateway.cancelWait !== undefined && gateway.reattachWait !== undefined;
}

export type McpTmuxWaitGateway = McpWaitTrackingGateway & Required<Pick<
    McpInstanceGateway,
    "observeTmuxTask"
>>;

export function isMcpTmuxWaitGateway(
    gateway: McpInstanceGateway | undefined
): gateway is McpTmuxWaitGateway {
    return isMcpWaitTrackingGateway(gateway) && gateway.observeTmuxTask !== undefined;
}

export type McpWorkspaceGateway = McpInteractionGateway & Required<Pick<
    McpInstanceGateway,
    "readToolCalls" | "readWorkspaceEvents"
>>;

export function isMcpWorkspaceGateway(
    gateway: McpInstanceGateway | undefined
): gateway is McpWorkspaceGateway {
    return isMcpInteractionGateway(gateway) &&
        gateway.readToolCalls !== undefined &&
        gateway.readWorkspaceEvents !== undefined;
}

export type McpGoalGateway = McpInstanceGateway & Required<Pick<
    McpInstanceGateway,
    "goalContinuation" | "manageGoal" | "readGoal"
>>;

export function isMcpGoalGateway(gateway: McpInstanceGateway | undefined): gateway is McpGoalGateway {
    return gateway !== undefined &&
        gateway.goalContinuation !== undefined &&
        gateway.manageGoal !== undefined &&
        gateway.readGoal !== undefined;
}
