import type { JsonValue } from "../JsonValue.js";

export const bootstrapToolNamespace = "environ" as const;

export function toolNamespace(name: string): string | undefined {
    const separator = name.indexOf("_");
    if (
        separator <= 0 ||
        separator === name.length - 1 ||
        name.indexOf("_", separator + 1) !== -1
    ) {
        return undefined;
    }
    const namespace = name.slice(0, separator);
    const operation = name.slice(separator + 1);
    return /^[a-z0-9]+$/u.test(namespace) && /^[A-Za-z0-9]+$/u.test(operation)
        ? namespace
        : undefined;
}

export interface ToolDefinition {
    _meta?: JsonValue;
    description: string;
    group: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
    requiredCapabilities: readonly ToolCapability[];
}

export interface ToolSessionOpenResult {
    tools: ToolDefinition[];
    workspace: string;
}

export type ToolCapability = "read" | "write" | "execute" | "manage";

type ParseSuccess<T> = { data: T; success: true };
type ParseFailure = { error: Error; success: false };
type ParseResult<T> = ParseFailure | ParseSuccess<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCapability(value: unknown): value is ToolCapability {
    return (
        value === "read" ||
        value === "write" ||
        value === "execute" ||
        value === "manage"
    );
}

function parseRequiredCapabilities(value: unknown): ToolCapability[] {
    if (!Array.isArray(value))
        throw new Error("tool.requiredCapabilities must be an array");
    const capabilities: ToolCapability[] = [];
    const seen = new Set<ToolCapability>();
    for (const capability of value) {
        if (!isToolCapability(capability)) {
            throw new Error(
                "tool.requiredCapabilities contains an invalid capability",
            );
        }
        if (seen.has(capability)) {
            throw new Error(
                `tool.requiredCapabilities contains duplicate capability: ${capability}`,
            );
        }
        seen.add(capability);
        capabilities.push(capability);
    }
    return capabilities;
}

export const toolSchema = {
    parse(value: unknown): ToolDefinition {
        if (!isRecord(value))
            throw new Error("tool definition must be an object");
        if (typeof value.name !== "string" || value.name.length === 0) {
            throw new Error("tool.name must be a non-empty string");
        }
        const namespace = toolNamespace(value.name);
        if (namespace === undefined)
            throw new Error("tool.name must use namespace_operation form");
        if (typeof value.description !== "string")
            throw new Error("tool.description must be a string");
        if (typeof value.group !== "string" || value.group.length === 0) {
            throw new Error("tool.group must be a non-empty string");
        }
        if (value.group !== namespace) {
            throw new Error(
                `tool.group ${value.group} must match namespace ${namespace} from tool.name ${value.name}`,
            );
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
            requiredCapabilities: parseRequiredCapabilities(
                value.requiredCapabilities,
            ),
        };
    },
    safeParse(value: unknown): ParseResult<ToolDefinition> {
        try {
            return { data: this.parse(value), success: true };
        } catch (error) {
            return {
                error:
                    error instanceof Error ? error : new Error(String(error)),
                success: false,
            };
        }
    },
};
