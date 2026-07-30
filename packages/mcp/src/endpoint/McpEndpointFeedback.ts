import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import { McpToolSchemaUnavailableError } from "../tool/McpToolSchemaAdapter.js";

const commentSchema: JsonValue = {
    description: "User comments for this session context.",
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
    const required = Array.isArray(tool.outputSchema.required)
        ? tool.outputSchema.required.filter((entry): entry is string => typeof entry === "string")
        : [];

    return {
        ...tool,
        outputSchema: {
            ...tool.outputSchema,
            properties: {
                ...properties,
                comment: commentSchema
            },
            required: required.includes("comment") ? required : [...required, "comment"]
        }
    };
}

export function attachMcpComments(result: JsonValue, comments: readonly string[]): JsonValue {
    if (!isRecord(result)) {
        throw new Error("MCP tool results must be objects when context comments are enabled.");
    }
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
