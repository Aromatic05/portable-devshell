import { createError, errorCodes, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpEndpointCatalogWorker } from "../McpEndpointCatalog.js";
import { throwIfMcpEndpointAborted } from "../McpEndpointCancellation.js";
import type { McpEndpointEnvironmentHandshake, McpEndpointWorkerPort } from "../McpEndpointPort.js";

const DEFAULT_READY_WAIT_MS = 5_000;
const DEFAULT_READY_POLL_MS = 50;

export function assertMcpEndpointReady(
    worker: Pick<McpEndpointCatalogWorker, "snapshot">,
    instanceName: string
): void {
    if (!worker.snapshot().ready) {
        throw createError({
            code: errorCodes.coreInstanceNotReady,
            details: { instance: instanceName },
            message: `Instance ${instanceName} is not ready.`,
            retryable: false
        });
    }
}

export async function waitForMcpEndpointReady(
    worker: Pick<McpEndpointCatalogWorker, "snapshot">,
    instanceName: string,
    signal?: AbortSignal,
    options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_READY_WAIT_MS;
    const pollMs = options.pollMs ?? DEFAULT_READY_POLL_MS;
    const deadline = Date.now() + timeoutMs;

    while (worker.snapshot().ready !== true) {
        throwIfMcpEndpointAborted(signal);
        if (Date.now() >= deadline) {
            throw createError({
                code: errorCodes.coreInstanceNotReady,
                details: { instance: instanceName, waitedMs: timeoutMs },
                message: `Instance ${instanceName} is not ready.`,
                retryable: false
            });
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

export async function waitForMcpGatewayReady(
    gateway: McpInstanceGateway,
    instance: string,
    signal?: AbortSignal,
    options: { timeoutMs?: number; pollMs?: number } = {}
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
                    throw createError({
                        code: errorCodes.coreInstanceNotReady,
                        details: { instance, waitedMs: timeoutMs },
                        message: `Instance ${instance} is not ready.`,
                        retryable: false
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
        ? (error as { code?: unknown }).code === errorCodes.coreInstanceNotReady
        : false;
}

export function requireMcpEndpointGateway(
    gateway: McpInstanceGateway | undefined,
    instanceName: string
): McpInstanceGateway {
    if (gateway !== undefined) {
        return gateway;
    }
    throw createError({
        code: errorCodes.coreToolSchemaUnavailable,
        details: { instance: instanceName },
        message: `Control tools are not available for ${instanceName}.`,
        retryable: false
    });
}

export async function auditMcpEndpointTool<T extends JsonValue>(options: {
    context: ToolCallContext;
    gateway?: McpInstanceGateway;
    input: JsonValue;
    localInstance: string;
    operation: (callId: string) => Promise<T>;
    signal?: AbortSignal;
    targetInstance: string;
    toolName: string;
    worker: Pick<McpEndpointWorkerPort, "auditToolCall">;
}): Promise<T> {
    if (options.targetInstance === options.localInstance) {
        return await options.worker.auditToolCall(
            options.toolName,
            options.input,
            options.context,
            options.operation,
            options.signal
        );
    }
    return await requireMcpEndpointGateway(options.gateway, options.localInstance).auditToolCall(
        options.targetInstance,
        options.toolName,
        options.input,
        options.context,
        options.operation,
        options.signal
    );
}

export function requireMcpEndpointEnvironment(
    worker: McpEndpointWorkerPort,
    instanceName: string
): McpEndpointEnvironmentHandshake {
    if (worker.handshake !== undefined) {
        return worker.handshake;
    }
    throw createError({
        code: errorCodes.coreWorkerHandshakeFailed,
        details: { instance: instanceName },
        message: `Environment information is unavailable for ${instanceName}.`,
        retryable: true
    });
}

export function mcpEndpointToolNotExposed(
    toolName: string,
    instanceName: string
) {
    return createError({
        code: errorCodes.coreToolSchemaUnavailable,
        details: { instance: instanceName, toolName },
        message: `Tool ${toolName} is not exposed by MCP.`,
        retryable: false
    });
}
