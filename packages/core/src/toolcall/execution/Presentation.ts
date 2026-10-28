import type { JsonValue, ToolCallPresentation } from "@portable-devshell/shared";

// MCP presentation has one outbound payload contract. Rewrite must preserve
// this envelope and rewrite both structuredContent and native content as needed.
export function mcpOutboundResult(result: JsonValue, presentation: ToolCallPresentation): JsonValue {
    return {
        content: (presentation.content ?? []).map((entry): JsonValue => {
            if (entry.type === "text") return { type: "text", text: entry.text };
            return { type: "image", data: entry.data, mimeType: entry.mediaType };
        }),
        ...(presentation.isError === undefined ? {} : { isError: presentation.isError }),
        structuredContent: result,
    };
}

export function assertMcpOutboundResult(value: JsonValue): void {
    if (!isRecord(value) || !("structuredContent" in value) ||
        !Array.isArray(value.content) ||
        (value.isError !== undefined && typeof value.isError !== "boolean") ||
        value.content.some((entry) => !isRecord(entry) ||
            (entry.type === "text"
                ? typeof entry.text !== "string"
                : entry.type !== "image" || typeof entry.data !== "string" || typeof entry.mimeType !== "string"))) {
        throw new TypeError("MCP outbound Rewrite must preserve the content/structuredContent result envelope.");
    }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
