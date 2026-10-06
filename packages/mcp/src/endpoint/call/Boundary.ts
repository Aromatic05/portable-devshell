import type { CallToolResult } from "@modelcontextprotocol/server";
import {
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ToolCallPresentation,
} from "@portable-devshell/shared";

export function mcpEndpointToolNotExposed(
    toolName: string,
    instanceName: string,
) {
    return createRemoteError({
        code: runtimeErrorCodes.toolSchemaUnavailable,
        details: { instance: instanceName, toolName },
        message: `Tool ${toolName} is not exposed by MCP.`,
        retryable: false,
    });
}

export function throwIfMcpEndpointAborted(
    signal: AbortSignal | undefined,
): void {
    if (signal?.aborted === true) {
        throw mcpEndpointCancellationError(signal.reason);
    }
}

export async function waitForMcpEndpointAbortable<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    throwIfMcpEndpointAborted(signal);
    if (signal === undefined) {
        return await operation;
    }
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () =>
            reject(mcpEndpointCancellationError(signal.reason));
        signal.addEventListener("abort", onAbort, { once: true });
        void operation
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
    });
}

function mcpEndpointCancellationError(reason: unknown) {
    return createRemoteError({
        code: runtimeErrorCodes.toolCallCancelled,
        cause: reason,
        message: "MCP tool call was cancelled by the client.",
        retryable: true,
        details: {
            reason: typeof reason === "string" ? reason : "client cancelled",
        },
    });
}

export function presentMcpEndpointResult(
    result: JsonValue,
    presentation: ToolCallPresentation | undefined,
): McpEndpointResult {
    if (presentation === undefined) return result;
    return new McpNativeToolResult({
        content: (presentation.content ?? []).map((entry) =>
            entry.type === "text"
                ? { text: entry.text, type: "text" as const }
                : {
                      data: entry.data,
                      mimeType: entry.mediaType,
                      type: "image" as const,
                  },
        ),
        ...(presentation.isError === undefined
            ? {}
            : { isError: presentation.isError }),
        structuredContent: result,
    });
}

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
