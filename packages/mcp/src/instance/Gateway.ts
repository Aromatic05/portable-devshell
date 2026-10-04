import type { ToolCallHookValue } from "@portable-devshell/shared";
import type {
    ApprovalRequest,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
    GoalActivityKind,
    GoalContinuationInput,
    GoalManageInput,
    GoalSnapshot,
    InstanceEventRecord,
    JsonValue,
    TodoReadInput,
    TodoTaskControlAction,
    ToolCallContext,
    ToolCallRecord,
    WaitCreateInput,
    WaitRecord,
} from "@portable-devshell/shared";

export interface McpEndpointEnvironmentHandshake {
    homeDirectory: string;
    instance: string;
    platform: {
        arch: string;
        distribution?: {
            id: string;
            name: string;
            version?: string;
        };
        os: string;
        packageManager?: string;
        shell?: {
            executable: string;
            kind: string;
            version: string;
        };
    };
}

export interface McpWorkspaceEventSlice {
    events: InstanceEventRecord[];
    gap: boolean;
    lastSeq: number;
}

export interface McpExtensionToolResult {
    content?: readonly {
        text: string;
        type: "text";
    }[];
    isError?: boolean;
    structuredContent: JsonValue;
}

export interface McpApprovalPort {
    listApprovals(instance: string): Promise<ApprovalRequest[]>;
    listPendingApprovals(instance: string, ctxId?: string): Promise<ApprovalRequest[]>;
    decideApproval?(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<ApprovalRequest>;
    cancelApproval?(instance: string, approvalId: string, reason?: string): Promise<ApprovalRequest>;
}

interface McpGatewayShape {
    approval?: McpApprovalPort;
    appendMcpToolCalled(
        instance: string,
        toolName: string,
        context: { requestId?: string; ctxId?: string },
    ): Promise<void>;
    assertReady(instance: string): void;
    callTool(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
        ) => Promise<JsonValue>,
        invocationInput?: (input: JsonValue, callId: string, finalValue: ToolCallHookValue) => Promise<JsonValue> | JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording?: "caller" | "host",
    ): Promise<JsonValue>;
    closeToolSession?(sessionId: string): Promise<void>;
    environment(instance: string): McpEndpointEnvironmentHandshake | undefined;
    modelCommands?(instance: string): readonly string[];
    listInstances(): Promise<JsonValue>;
    goalContinuation?(
        instance: string,
        input: GoalContinuationInput,
        ctxId: string,
    ): Promise<JsonValue>;
    manageGoal?(
        instance: string,
        input: GoalManageInput,
        ctxId: string,
    ): Promise<GoalSnapshot | undefined>;
    readGoal?(
        instance: string,
        ctxId: string,
    ): Promise<GoalSnapshot | undefined>;
    recordGoalReentry?(
        instance: string,
        ctxId: string,
        progressEpoch?: number,
    ): Promise<void>;
    touchGoal?(
        instance: string,
        ctxId: string,
        kind?: GoalActivityKind,
    ): Promise<void>;
    createWait?(instance: string, input: WaitCreateInput): Promise<WaitRecord>;
    cancelWait?(instance: string, waitId: string): Promise<WaitRecord>;
    claimWaitRecovery?(
        instance: string,
        waitId: string,
        claimId: string,
    ): Promise<WaitRecord>;
    completeWaitRecovery?(
        instance: string,
        waitId: string,
        claimId: string,
    ): Promise<WaitRecord>;
    markWaitRecoveryAttempted?(
        instance: string,
        waitId: string,
        claimId: string,
        goalProgressEpoch?: number,
    ): Promise<WaitRecord>;
    detachWait?(instance: string, waitId: string): Promise<WaitRecord>;
    dismissWaitRecovery?(
        instance: string,
        waitId: string,
        recoveryMessageId: string,
    ): Promise<WaitRecord>;
    reattachWait?(
        instance: string,
        waitId: string,
        ownerCallId?: string,
    ): Promise<WaitRecord>;
    releaseWaitRecovery?(
        instance: string,
        waitId: string,
        claimId: string,
    ): Promise<WaitRecord>;
    rejectWaitRecovery?(
        instance: string,
        waitId: string,
        claimId: string,
    ): Promise<WaitRecord>;
    disableWaitRecovery?(instance: string, waitId: string): Promise<WaitRecord>;
    consumeWait?(instance: string, waitId: string): Promise<WaitRecord>;
    resolveWait?(
        instance: string,
        waitId: string,
        result?: JsonValue,
        options?: { consumeIfDetached?: boolean },
    ): Promise<WaitRecord>;
    waitForWait?(instance: string, waitId: string): Promise<WaitRecord>;
    listWaits?(instance: string): Promise<WaitRecord[]>;
    readToolCalls?(
        instance: string,
        ctxId: string,
        limit: number,
    ): Promise<ToolCallRecord[]>;
    hasActiveToolCalls?(
        instance: string,
        ctxId: string,
        excludeCallId?: string,
    ): boolean;
    readWorkspaceEvents?(
        instance: string,
        fromSeq: number,
    ): Promise<McpWorkspaceEventSlice>;
    controlTodo?(
        instance: string,
        taskId: string,
        action: TodoTaskControlAction,
        ctxId: string,
        expectedRevision?: number,
    ): Promise<JsonValue>;
    contextTerminated?(
        instance: string,
        ctxId: string,
        reason: "disabled" | "expired",
    ): Promise<void>;
    readTodo(instance: string, input?: TodoReadInput): Promise<JsonValue>;
    prepareWorkspace(
        instance: string,
        workspace: string,
    ): Promise<{
        projectMemoryAgentFile: string;
        projectMemoryDirectory: string;
        projectMemoryPresent?: boolean;
        temporaryDirectory: string;
        workspace: string;
    }>;
    readAlerts(
        instance: string,
        workspace: string,
    ): Promise<{ advice: Array<{ code: string; text: string }> }>;
    releaseAlerts(instance: string, workspace: string): Promise<void>;
    connectInstance(instance: string, reference: string): Promise<JsonValue>;
    releaseInstanceReference(
        instance: string,
        reference: string,
    ): Promise<void>;
    statusInstance(instance: string): Promise<JsonValue>;
    stopInstance(instance: string): Promise<JsonValue>;
    touchAlerts(
        instance: string,
        workspace: string,
    ): Promise<
        | void
        | {
              advice: Array<{ code: string; text: string }>;
          }
    >;
    touchTemporaryDirectory(instance: string, path: string): Promise<void>;


    viewArtifactImage?(
        defaultInstance: string,
        input: ArtifactViewImageInput,
        signal?: AbortSignal,
    ): Promise<ArtifactViewImageResult>;
}

export type McpToolCallPort = Pick<
    McpGatewayShape,
    | "appendMcpToolCalled"
    | "callTool"
    | "closeToolSession"
    | "readToolCalls"
    | "hasActiveToolCalls"
>;

export type McpTaskPort = Pick<
    McpGatewayShape,
    | "goalContinuation"
    | "manageGoal"
    | "readGoal"
    | "recordGoalReentry"
    | "touchGoal"
    | "createWait"
    | "cancelWait"
    | "claimWaitRecovery"
    | "completeWaitRecovery"
    | "markWaitRecoveryAttempted"
    | "detachWait"
    | "dismissWaitRecovery"
    | "reattachWait"
    | "releaseWaitRecovery"
    | "rejectWaitRecovery"
    | "disableWaitRecovery"
    | "consumeWait"
    | "resolveWait"
    | "waitForWait"
    | "listWaits"
    | "controlTodo"
    | "readTodo"
>;

export type McpInstancePort = Pick<
    McpGatewayShape,
    | "assertReady"
    | "environment"
    | "modelCommands"
    | "listInstances"
    | "contextTerminated"
    | "prepareWorkspace"
    | "readAlerts"
    | "releaseAlerts"
    | "connectInstance"
    | "releaseInstanceReference"
    | "statusInstance"
    | "stopInstance"
    | "touchAlerts"
    | "touchTemporaryDirectory"
>;

export type McpWorkspaceEventPort = Pick<McpGatewayShape, "readWorkspaceEvents">;
export type McpArtifactPort = Pick<McpGatewayShape, "viewArtifactImage">;
export type McpWorkspacePort = McpTaskPort &
    Pick<McpToolCallPort, "readToolCalls" | "hasActiveToolCalls"> &
    McpWorkspaceEventPort & {
        approval?: McpApprovalPort;
    };

/** @deprecated Prefer the narrow domain ports above. */
export interface McpInstanceGateway
    extends McpToolCallPort,
        McpTaskPort,
        McpInstancePort,
        McpWorkspaceEventPort,
        McpArtifactPort {
    approval?: McpApprovalPort;
}

export type McpWorkspaceActionGateway = McpWorkspacePort &
    Required<
        Pick<
            McpTaskPort,
            | "createWait"
            | "detachWait"
            | "consumeWait"
            | "resolveWait"
            | "waitForWait"
            | "listWaits"
        >
    > & { approval: McpApprovalPort & Required<Pick<McpApprovalPort, "decideApproval">> };

export function isMcpWorkspaceActionGateway(
    gateway: McpWorkspacePort | undefined,
): gateway is McpWorkspaceActionGateway {
    return (
        gateway !== undefined &&
        gateway.createWait !== undefined &&
        gateway.detachWait !== undefined &&
        gateway.consumeWait !== undefined &&
        gateway.resolveWait !== undefined &&
        gateway.waitForWait !== undefined &&
        gateway.listWaits !== undefined &&
        gateway.approval !== undefined &&
        gateway.approval.listPendingApprovals !== undefined &&
        gateway.approval.decideApproval !== undefined
    );
}

export function requireMcpWorkspaceActionGateway(
    gateway: McpWorkspacePort | undefined,
    instanceName: string,
): McpWorkspaceActionGateway {
    if (isMcpWorkspaceActionGateway(gateway)) return gateway;
    throw new Error(
        `Workspace interaction backend is unavailable for ${instanceName}.`,
    );
}

export type McpWaitRecoveryGateway = McpWorkspaceActionGateway &
    Required<
        Pick<
            McpTaskPort,
            | "claimWaitRecovery"
            | "completeWaitRecovery"
            | "disableWaitRecovery"
            | "dismissWaitRecovery"
            | "markWaitRecoveryAttempted"
            | "rejectWaitRecovery"
            | "releaseWaitRecovery"
        >
    >;

export function isMcpWaitRecoveryGateway(
    gateway: McpWorkspacePort | undefined,
): gateway is McpWaitRecoveryGateway {
    return (
        isMcpWorkspaceActionGateway(gateway) &&
        gateway.claimWaitRecovery !== undefined &&
        gateway.completeWaitRecovery !== undefined &&
        gateway.dismissWaitRecovery !== undefined &&
        gateway.markWaitRecoveryAttempted !== undefined &&
        gateway.rejectWaitRecovery !== undefined &&
        gateway.disableWaitRecovery !== undefined &&
        gateway.releaseWaitRecovery !== undefined
    );
}

export type McpWaitTrackingGateway = McpWorkspaceActionGateway &
    Required<Pick<McpTaskPort, "cancelWait" | "reattachWait">>;

export function isMcpWaitTrackingGateway(
    gateway: McpWorkspacePort | undefined,
): gateway is McpWaitTrackingGateway {
    return (
        isMcpWorkspaceActionGateway(gateway) &&
        gateway.cancelWait !== undefined &&
        gateway.reattachWait !== undefined
    );
}

export type McpWorkspaceGateway = McpWorkspaceActionGateway &
    Required<Pick<McpToolCallPort, "readToolCalls" | "hasActiveToolCalls">> &
    Required<Pick<McpWorkspaceEventPort, "readWorkspaceEvents">>;

export function isMcpWorkspaceGateway(
    gateway: McpWorkspacePort | undefined,
): gateway is McpWorkspaceGateway {
    return (
        isMcpWorkspaceActionGateway(gateway) &&
        gateway.readToolCalls !== undefined &&
        gateway.readWorkspaceEvents !== undefined
    );
}

export type McpGoalGateway = Required<
    Pick<McpTaskPort, "goalContinuation" | "manageGoal" | "readGoal">
>;

export function isMcpGoalGateway(
    gateway:
        | Pick<McpTaskPort, "goalContinuation" | "manageGoal" | "readGoal">
        | undefined,
): gateway is McpGoalGateway {
    return (
        gateway !== undefined &&
        gateway.goalContinuation !== undefined &&
        gateway.manageGoal !== undefined &&
        gateway.readGoal !== undefined
    );
}

export function requireMcpGoalGateway(
    gateway:
        | Pick<McpTaskPort, "goalContinuation" | "manageGoal" | "readGoal">
        | undefined,
    instanceName: string,
): McpGoalGateway {
    if (isMcpGoalGateway(gateway)) return gateway;
    throw new Error(
        `Workspace Goal backend is unavailable for ${instanceName}.`,
    );
}
