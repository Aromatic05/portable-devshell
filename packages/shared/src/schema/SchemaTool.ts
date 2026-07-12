import type { ToolCapability, ToolDefinition } from "../dto/tool/DtoToolDefinition.js";
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

function isToolCapability(value: unknown): value is ToolCapability {
    return value === "read" || value === "write" || value === "execute" || value === "manage";
}

function parseRequiredCapabilities(value: unknown): ToolCapability[] {
    if (!Array.isArray(value)) {
        throw new Error("tool.requiredCapabilities must be an array");
    }

    const capabilities: ToolCapability[] = [];
    const seen = new Set<ToolCapability>();

    for (const capability of value) {
        if (!isToolCapability(capability)) {
            throw new Error("tool.requiredCapabilities contains an invalid capability");
        }
        if (seen.has(capability)) {
            throw new Error(`tool.requiredCapabilities contains duplicate capability: ${capability}`);
        }
        seen.add(capability);
        capabilities.push(capability);
    }

    return capabilities;
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

        return {
            description: value.description,
            group: value.group,
            inputSchema: value.inputSchema as JsonValue,
            name: value.name,
            outputSchema: value.outputSchema as JsonValue,
            requiredCapabilities: parseRequiredCapabilities(value.requiredCapabilities)
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
