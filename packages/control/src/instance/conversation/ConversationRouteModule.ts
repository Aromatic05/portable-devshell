import {
    createError,
    errorCodes,
    type ConversationListInput,
    type JsonValue,
    type PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import type { ConversationService } from "./ConversationService.js";

export function createConversationRouteModule(
    service: Pick<ConversationService, "list">,
): PrefixRouteModuleDefinition {
    return routeModule("conversation", {
        list: async (request) => await service.list(readListInput(request.payload ?? {})) as unknown as JsonValue,
    });
}

function readListInput(value: JsonValue): ConversationListInput {
    if (!isRecord(value) || Object.keys(value).some((key) => !["before", "ctxId", "limit", "maxBytes"].includes(key))) {
        throw invalid("conversation.list accepts only before, ctxId, limit, and maxBytes.");
    }
    if (value.before !== undefined && typeof value.before !== "string") throw invalid("conversation.list before must be a string.");
    if (value.ctxId !== undefined && typeof value.ctxId !== "string") throw invalid("conversation.list ctxId must be a string.");
    if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit))) {
        throw invalid("conversation.list limit must be an integer.");
    }
    if (value.maxBytes !== undefined && (typeof value.maxBytes !== "number" || !Number.isSafeInteger(value.maxBytes))) {
        throw invalid("conversation.list maxBytes must be an integer.");
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
