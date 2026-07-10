import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

export interface McpTool {
    [key: string]: JsonValue;
    description: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
}

export class McpToolSchemaUnavailableError extends Error {
    readonly code = "mcp.toolSchemaUnavailable";

    constructor(toolName: string) {
        super(`Tool schema unavailable for ${toolName}.`);
        this.name = "McpToolSchemaUnavailableError";
    }
}

export class McpToolSchemaAdapter {
    toMcpTool(tool: ToolDefinition, description: string): McpTool {
        if (tool.inputSchema === undefined || tool.outputSchema === undefined) {
            throw new McpToolSchemaUnavailableError(tool.name);
        }

        return {
            description,
            inputSchema: tool.inputSchema,
            name: tool.name,
            outputSchema: tool.outputSchema
        };
    }
}
