import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonValue } from "@portable-devshell/shared";

export class McpNativeToolResult {
    readonly _meta?: CallToolResult["_meta"];
    readonly content: CallToolResult["content"];
    readonly isError: boolean;
    readonly structuredContent: JsonValue;

    constructor(input: {
        _meta?: CallToolResult["_meta"];
        content: CallToolResult["content"];
        isError?: boolean;
        structuredContent: JsonValue;
    }) {
        this._meta = input._meta;
        this.content = input.content;
        this.isError = input.isError ?? false;
        this.structuredContent = input.structuredContent;
    }
}

export type McpEndpointResult = JsonValue | McpNativeToolResult;
