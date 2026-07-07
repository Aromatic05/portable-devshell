import type { JsonValue } from "../../type/TypeJsonValue.js";

export interface ToolDefinition {
    description?: string;
    inputSchema: JsonValue;
    name: string;
}
