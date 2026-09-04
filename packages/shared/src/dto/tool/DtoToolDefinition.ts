import type { JsonValue } from "../../type/TypeJsonValue.js";

export const bootstrapToolNamespace = "environ" as const;

export function toolNamespace(name: string): string | undefined {
    const separator = name.indexOf("_");
    if (
        separator <= 0
        || separator === name.length - 1
        || name.indexOf("_", separator + 1) !== -1
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

export type ToolCapability = "read" | "write" | "execute" | "manage";

export interface ToolPolicy {
    capabilities: readonly ToolCapability[];
    groups: readonly string[];
}
