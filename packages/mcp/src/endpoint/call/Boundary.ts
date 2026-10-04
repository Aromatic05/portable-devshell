import type { CallToolResult } from "@modelcontextprotocol/server";
import {
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ToolCallContext,
} from "@portable-devshell/shared";

import type {
    McpEndpointEnvironmentHandshake,
    McpInstancePort,
    McpToolCallPort,
} from "../../instance/Gateway.js";

const DEFAULT_READY_WAIT_MS = 5_000;
const DEFAULT_READY_POLL_MS = 50;

export function assertMcpEndpointReady(
    worker: { snapshot(): { ready?: boolean } },
    instanceName: string,
): void {
    if (!worker.snapshot().ready) {
        throw createRemoteError({
            code: runtimeErrorCodes.instanceNotReady,
            details: { instance: instanceName },
            message: `Instance ${instanceName} is not ready.`,
            retryable: false,
        });
    }
}

export async function waitForMcpGatewayReady(
    gateway: Pick<McpInstancePort, "assertReady">,
    instance: string,
    signal?: AbortSignal,
    options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_READY_WAIT_MS;
    const pollMs = options.pollMs ?? DEFAULT_READY_POLL_MS;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        try {
            gateway.assertReady(instance);
            return;
        } catch (error) {
            if (isNotReadyError(error)) {
                throwIfMcpEndpointAborted(signal);
                if (Date.now() >= deadline) {
                    throw createRemoteError({
                        code: runtimeErrorCodes.instanceNotReady,
                        details: { instance, waitedMs: timeoutMs },
                        message: `Instance ${instance} is not ready.`,
                        retryable: false,
                    });
                }
                await new Promise((resolve) => setTimeout(resolve, pollMs));
                continue;
            }
            throw error;
        }
    }
}

function isNotReadyError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code === runtimeErrorCodes.instanceNotReady
        : false;
}

export function requireMcpEndpointGateway<T>(
    gateway: T | undefined,
    instanceName: string,
): T {
    if (gateway !== undefined) {
        return gateway;
    }
    throw createRemoteError({
        code: runtimeErrorCodes.toolSchemaUnavailable,
        details: { instance: instanceName },
        message: `Control tools are not available for ${instanceName}.`,
        retryable: false,
    });
}

export function requireMcpEndpointEnvironment(
    worker: { readonly handshake?: McpEndpointEnvironmentHandshake },
    instanceName: string,
): McpEndpointEnvironmentHandshake {
    if (worker.handshake !== undefined) {
        return worker.handshake;
    }
    throw createRemoteError({
        code: runtimeErrorCodes.workerHandshakeFailed,
        details: { instance: instanceName },
        message: `Environment information is unavailable for ${instanceName}.`,
        retryable: true,
    });
}

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
