import type { JsonValue } from "../../type/TypeJsonValue.js";

export interface ToolDefinition {
    access: ToolAccess;
    description: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
}

export type ToolAccess = "read" | "write" | "execute" | "session";
