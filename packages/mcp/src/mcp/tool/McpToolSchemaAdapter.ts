type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

interface ToolDefinition {
    description?: string;
    inputSchema?: JsonValue;
    name: string;
}

export interface McpTool {
    [key: string]: JsonValue;
    description: string;
    inputSchema: JsonValue;
    name: string;
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
        if (tool.inputSchema === undefined) {
            throw new McpToolSchemaUnavailableError(tool.name);
        }

        return {
            description,
            inputSchema: tool.inputSchema,
            name: tool.name
        };
    }
}
