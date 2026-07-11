import type { ToolDefinition } from "../dto/tool/DtoToolDefinition.js";
import type { JsonValue } from "../type/TypeJsonValue.js";

type ParseSuccess<T> = {
    data: T;
    success: true;
};

type ParseFailure = {
    error: Error;
    success: false;
};

type ParseResult<T> = ParseFailure | ParseSuccess<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const toolSchema = {
    parse(value: unknown): ToolDefinition {
        if (!isRecord(value)) {
            throw new Error("tool definition must be an object");
        }

        if (typeof value.name !== "string" || value.name.length === 0) {
            throw new Error("tool.name must be a non-empty string");
        }

        if (typeof value.description !== "string") {
            throw new Error("tool.description must be a string");
        }

        if (typeof value.group !== "string" || value.group.length === 0) {
            throw new Error("tool.group must be a non-empty string");
        }

        if (!isRecord(value.inputSchema) || !isRecord(value.outputSchema)) {
            throw new Error("tool schemas must be JSON objects");
        }

        if (value.access !== "read" && value.access !== "write" && value.access !== "execute" && value.access !== "manage") {
            throw new Error("tool.access is invalid");
        }

        return {
            access: value.access,
            description: value.description,
            group: value.group,
            inputSchema: value.inputSchema as JsonValue,
            name: value.name,
            outputSchema: value.outputSchema as JsonValue
        };
    },
    safeParse(value: unknown): ParseResult<ToolDefinition> {
        try {
            return {
                data: this.parse(value),
                success: true
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error : new Error(String(error)),
                success: false
            };
        }
    }
};
