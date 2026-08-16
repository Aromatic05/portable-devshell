import type {
    ArtifactShareInput,
    ArtifactTransferCancelInput,
    ArtifactTransferLookupInput,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult
} from "@portable-devshell/shared";
import type {
    ContextMessageReadResult,
    JsonValue,
    ToolCallContext,
    ToolDefinition
} from "@portable-devshell/shared";
import type { McpEndpointEnvironmentHandshake } from "../endpoint/McpEndpointPort.js";

export interface McpSshInstanceCreateInput {
    host: string;
    identityFile?: string;
    name: string;
    port?: number;
    user?: string;
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
    consumeContextMessages?(instance: string, ctxId: string, callId: string): Promise<ContextMessageReadResult>;
    readTodo(instance: string, title?: string): Promise<JsonValue>;
    listTools(instance: string): ToolDefinition[];
    prepareWorkspace(instance: string, workspace: string): Promise<{
        projectMemoryAgentFile: string;
        projectMemoryDirectory: string;
        temporaryDirectory: string;
        workspace: string;
    }>;
    readAlerts(instance: string, workspace: string): Promise<{ advice: Array<{ code: string; text: string }> }>;
    releaseAlerts(instance: string, workspace: string): Promise<void>;
    connectInstance(instance: string): Promise<JsonValue>;
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
