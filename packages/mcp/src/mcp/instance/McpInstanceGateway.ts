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
    callTool(instance: string, toolName: string, input: JsonValue, context: ToolCallContext): Promise<JsonValue>;
    createSshInstance(sourceInstance: string, input: McpSshInstanceCreateInput): Promise<JsonValue>;
    listInstances(): Promise<JsonValue>;
    listTools(instance: string): ToolDefinition[];
    startInstance(instance: string): Promise<JsonValue>;
    statusInstance(instance: string): Promise<JsonValue>;
    stopInstance(instance: string): Promise<JsonValue>;
}
