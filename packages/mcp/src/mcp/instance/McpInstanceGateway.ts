import type {
    ArtifactShareInput,
    ArtifactTransferCancelInput,
    ArtifactTransferLookupInput,
    ArtifactTransferStartInput
} from "@portable-devshell/shared";
import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";

export interface McpSshInstanceCreateInput {
    host: string;
    identityFile?: string;
    name: string;
    port?: number;
    user?: string;
    workspace: string;
}

export interface McpInstanceGateway {
    assertReady(instance: string): void;
    callTool(instance: string, toolName: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue>;
    closeToolSession?(sessionId: string): Promise<void>;
    createSshInstance(sourceInstance: string, input: McpSshInstanceCreateInput): Promise<JsonValue>;
    listInstances(): Promise<JsonValue>;
    readTodo(instance: string): Promise<JsonValue>;
    listTools(instance: string): ToolDefinition[];
    startInstance(instance: string): Promise<JsonValue>;
    statusInstance(instance: string): Promise<JsonValue>;
    stopInstance(instance: string): Promise<JsonValue>;
    writeTodo(instance: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue>;

    shareArtifact?(defaultInstance: string, input: ArtifactShareInput): Promise<JsonValue>;
    transferArtifact?(
        defaultInstance: string,
        input: ArtifactTransferStartInput | ArtifactTransferLookupInput | ArtifactTransferCancelInput
    ): Promise<JsonValue>;
}
