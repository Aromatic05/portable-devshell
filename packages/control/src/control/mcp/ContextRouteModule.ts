import type { McpContextRecord, JsonValue, PrefixRouteModuleDefinition } from "@portable-devshell/shared";
import { createError, errorCodes } from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../route/ControlRouteFactory.js";

export interface ContextAdminPort {
    disable(ctxId: string): Promise<McpContextRecord>;
    list(): Promise<McpContextRecord[]>;
    renew(ctxId: string): Promise<McpContextRecord>;
    validateForInstance(ctxId: string, instance: string): Promise<McpContextRecord>;
}

export function createContextRouteModule(
    port: ContextAdminPort | (() => ContextAdminPort | undefined) | undefined
): PrefixRouteModuleDefinition {
    const admin = () => requirePort(
        typeof port === "function" ? port() : port,
        "MCP contexts are not available."
    );
    return routeModule("context", {
        list: async () => await admin().list() as unknown as JsonValue,
        disable: async (request) => await admin().disable(readCtxId(request.payload)) as unknown as JsonValue,
        renew: async (request) => await admin().renew(readCtxId(request.payload)) as unknown as JsonValue
    });
}

function readCtxId(value: JsonValue | undefined): string {
    const ctxId = typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>).ctxId
        : undefined;
    if (typeof ctxId !== "string" || ctxId.trim().length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "context operation requires a ctxId string.",
            retryable: false
        });
    }
    return ctxId;
}
