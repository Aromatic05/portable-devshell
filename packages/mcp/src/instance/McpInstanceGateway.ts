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
        transformResult?: (result: JsonValue, callId: string) => Promise<JsonValue>
    ): Promise<JsonValue>;
    closeToolSession?(sessionId: string): Promise<void>;
    createSshInstance(sourceInstance: string, input: McpSshInstanceCreateInput): Promise<JsonValue>;
    environment(instance: string): McpEndpointEnvironmentHandshake | undefined;
    listInstances(): Promise<JsonValue>;
    createWait?(instance: string, input: WaitCreateInput): Promise<WaitRecord>;
    cancelWait?(instance: string, waitId: string): Promise<WaitRecord>;
    detachWait?(instance: string, waitId: string): Promise<WaitRecord>;
    reattachWait?(instance: string, waitId: string, ownerCallId?: string): Promise<WaitRecord>;
    consumeWait?(instance: string, waitId: string): Promise<WaitRecord>;
    resolveWait?(instance: string, waitId: string, result?: JsonValue): Promise<WaitRecord>;
    waitForWait?(instance: string, waitId: string): Promise<WaitRecord>;
    listWaits?(instance: string): Promise<WaitRecord[]>;
    listApprovals?(instance: string): Promise<ApprovalRequest[]>;
    decideApproval?(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<ApprovalRequest>;
    readToolCalls?(instance: string, ctxId: string, limit: number): Promise<ToolCallRecord[]>;
    readWorkspaceEvents?(instance: string, fromSeq: number): Promise<McpWorkspaceEventSlice>;
    controlTodo?(instance: string, taskId: string, action: TodoTaskControlAction, ctxId: string): Promise<JsonValue>;
    consumeContextMessages?(instance: string, ctxId: string, callId: string): Promise<ContextMessageReadResult>;
    readTodo(instance: string, input?: TodoReadInput): Promise<JsonValue>;
    listTools(instance: string): ToolDefinition[];
    prepareWorkspace(instance: string, workspace: string): Promise<{
        projectMemoryAgentFile: string;
        projectMemoryDirectory: string;
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
