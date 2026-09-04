import {
    createError,
    errorCodes,
    type ContextMessageListInput,
    type ContextMessageQueueInput,
    type JsonValue,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import type { ContextMessageService } from "./ContextMessageService.js";
import type { ContextAdminPort } from "../../control/mcp/ContextRouteModule.js";
import { requirePort, routeModule } from "../../route/ControlRouteFactory.js";

export function createContextMessageRouteModule(
    service: Pick<ContextMessageService, "list" | "queue">,
    instance: string,
    contextAdmin: (() => ContextAdminPort | undefined) | undefined
): PrefixRouteModuleDefinition {
    const admin = () => requirePort(
        contextAdmin?.(),
        "MCP contexts are not available."
    );
    return routeModule("contextMessage", {
        list: async (request) => await service.list(readListInput(request.payload ?? {})) as unknown as JsonValue,
        queue: async (request) => {
            const input = readQueueInput(request.payload ?? {});
            await admin().validateForInstance(input.ctxId, instance);
            return await service.queue(input) as unknown as JsonValue;
        }
    });
}

function readQueueInput(value: JsonValue): ContextMessageQueueInput {
    if (!isRecord(value) || typeof value.ctxId !== "string" || typeof value.text !== "string" || Object.keys(value).some((key) => key !== "ctxId" && key !== "text")) {
        throw invalid("contextMessage.queue requires only ctxId and text strings.");
    }
    return { ctxId: value.ctxId, text: value.text };
}

function readListInput(value: JsonValue): ContextMessageListInput {
    if (!isRecord(value) || Object.keys(value).some((key) => !["before", "ctxId", "limit", "maxBytes"].includes(key))) {
        throw invalid("contextMessage.list accepts only before, ctxId, limit, and maxBytes.");
    }
    if (value.before !== undefined && typeof value.before !== "string") throw invalid("contextMessage.list before must be a string.");
    if (value.ctxId !== undefined && typeof value.ctxId !== "string") throw invalid("contextMessage.list ctxId must be a string.");
    if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit))) {
        throw invalid("contextMessage.list limit must be an integer.");
    }
    if (value.maxBytes !== undefined && (typeof value.maxBytes !== "number" || !Number.isSafeInteger(value.maxBytes))) {
        throw invalid("contextMessage.list maxBytes must be an integer.");
    }
    return {
        ...(value.before === undefined ? {} : { before: value.before }),
        ...(value.ctxId === undefined ? {} : { ctxId: value.ctxId }),
        ...(value.limit === undefined ? {} : { limit: Math.min(Math.max(value.limit, 1), 1_000) }),
        ...(value.maxBytes === undefined ? {} : { maxBytes: Math.min(Math.max(value.maxBytes, 1), 1024 * 1024) }),
    };
}

function invalid(message: string): Error {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
