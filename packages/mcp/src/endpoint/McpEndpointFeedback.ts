import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";

const commentSchema: JsonValue = {
    description: "Actionable notes.",
    items: { minLength: 1, type: "string" },
    type: "array"
};

export function withMcpCommentOutputSchema(tool: ToolDefinition): ToolDefinition {
    if (!isRecord(tool.outputSchema) || !isObjectSchema(tool.outputSchema.type)) {
        throw new McpToolSchemaUnavailableError(tool.name);
    }
    const properties = isRecord(tool.outputSchema.properties)
        ? tool.outputSchema.properties
        : {};
    return {
        ...tool,
        outputSchema: {
            ...tool.outputSchema,
            properties: {
                ...properties,
                comment: commentSchema
            }
        }
    };
}

export function attachMcpComments(result: JsonValue, comments: readonly string[]): JsonValue {
    if (!isRecord(result)) {
        throw new Error("MCP tool results must be objects when context comments are enabled.");
    }
    if (comments.length === 0) return result;
    return {
        ...result,
        comment: [...comments]
    };
}

function isObjectSchema(type: JsonValue | undefined): boolean {
    if (type === undefined || type === "object") {
        return true;
    }
    return Array.isArray(type) && type.includes("object");
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
