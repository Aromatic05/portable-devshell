import type { JsonValue } from "../types/JsonValue.js";

export interface ToolDefinition {
    description?: string;
    inputSchema: JsonValue;
    name: string;
}
