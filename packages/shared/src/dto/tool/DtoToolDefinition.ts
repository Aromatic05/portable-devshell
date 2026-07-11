import type { JsonValue } from "../../type/TypeJsonValue.js";

export interface ToolDefinition {
    access: ToolAccess;
    description: string;
    group: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
}

export type ToolAccess = "read" | "write" | "execute" | "manage";

export interface ToolPolicy {
    capabilities: readonly ToolAccess[];
    groups: readonly string[];
}
