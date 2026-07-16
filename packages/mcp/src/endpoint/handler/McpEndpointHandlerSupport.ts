import { createError, errorCodes } from "@portable-devshell/shared";

import type { McpInstanceGateway } from "../../instance/McpInstanceGateway.js";
import type { McpEndpointCatalogWorker } from "../McpEndpointCatalog.js";
import type { McpEndpointEnvironmentHandshake, McpEndpointWorkerPort } from "../McpEndpointPort.js";

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
