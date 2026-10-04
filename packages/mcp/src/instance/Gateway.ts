import type { ToolCallHookValue } from "@portable-devshell/shared";
import type {
    ApprovalRequest,
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
    ToolCallPresentation,
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

export interface McpAppEventSlice {
    events: InstanceEventRecord[];
    gap: boolean;
    lastSeq: number;
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
            presentation?: ToolCallPresentation,
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
    readMcpAppEvents?(
        instance: string,
        fromSeq: number,
    ): Promise<McpAppEventSlice>;
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

export type McpAppEventPort = Pick<McpGatewayShape, "readMcpAppEvents">;
export type McpAppPort = McpTaskPort &
    Pick<McpToolCallPort, "readToolCalls" | "hasActiveToolCalls"> &
    McpAppEventPort & {
        approval?: McpApprovalPort;
    };

/** @deprecated Prefer the narrow domain ports above. */
export interface McpInstanceGateway
    extends McpToolCallPort,
        McpTaskPort,
        McpInstancePort,
        McpAppEventPort {
    approval?: McpApprovalPort;
}

export type McpAppActionGateway = McpAppPort & {
    approval: McpApprovalPort & Required<Pick<McpApprovalPort, "decideApproval">>;
};

export function isMcpAppActionGateway(
    gateway: McpAppPort | undefined,
): gateway is McpAppActionGateway {
    return (
        gateway !== undefined &&
        gateway.approval !== undefined &&
        gateway.approval.listPendingApprovals !== undefined &&
        gateway.approval.decideApproval !== undefined
    );
}

export function requireMcpAppActionGateway(
    gateway: McpAppPort | undefined,
    instanceName: string,
): McpAppActionGateway {
    if (isMcpAppActionGateway(gateway)) return gateway;
    throw new Error(
        `MCP App interaction backend is unavailable for ${instanceName}.`,
    );
}


export type McpAppGateway = McpAppActionGateway &
    Required<Pick<McpToolCallPort, "readToolCalls" | "hasActiveToolCalls">> &
    Required<Pick<McpAppEventPort, "readMcpAppEvents">>;

export function isMcpAppGateway(
    gateway: McpAppPort | undefined,
): gateway is McpAppGateway {
    return (
        isMcpAppActionGateway(gateway) &&
        gateway.readToolCalls !== undefined &&
        gateway.readMcpAppEvents !== undefined
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
        `MCP App Goal backend is unavailable for ${instanceName}.`,
    );
}
