import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonValue } from "@portable-devshell/shared";

export class McpNativeToolResult {
    readonly content: CallToolResult["content"];
    readonly isError: boolean;
    readonly structuredContent: JsonValue;

    constructor(input: {
        content: CallToolResult["content"];
        isError?: boolean;
        structuredContent: JsonValue;
    }) {
        this.content = input.content;
        this.isError = input.isError ?? false;
        this.structuredContent = input.structuredContent;
    }
}

export type McpEndpointResult = JsonValue | McpNativeToolResult;
