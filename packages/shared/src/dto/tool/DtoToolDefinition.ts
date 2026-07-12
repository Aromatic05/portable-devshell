import type { JsonValue } from "../../type/TypeJsonValue.js";

export interface ToolDefinition {
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
