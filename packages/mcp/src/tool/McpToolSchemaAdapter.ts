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
            inputSchema: normalizeSchema(tool.inputSchema),
            name: tool.name,
            outputSchema: normalizeSchema(tool.outputSchema)
        };
    }
}

function normalizeSchema(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
        return value.map(normalizeSchema);
    }
    if (value === null || typeof value !== "object") {
        return value;
    }

    const source = value as Record<string, JsonValue>;
    const numeric = isNumericType(source.type);
    const normalized: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(source)) {
        if (numeric && key === "format") {
            continue;
        }
        normalized[key] = normalizeSchema(entry);
    }
    return normalized;
}

function isNumericType(value: JsonValue | undefined): boolean {
    if (value === "integer" || value === "number") {
        return true;
    }
    return Array.isArray(value) && value.some((entry) => entry === "integer" || entry === "number");
}
