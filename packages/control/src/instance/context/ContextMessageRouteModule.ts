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
        list: async (request) => await service.list(readListInput(request.payload ?? {}).ctxId) as unknown as JsonValue,
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
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "ctxId") || (value.ctxId !== undefined && typeof value.ctxId !== "string")) {
        throw invalid("contextMessage.list accepts only an optional ctxId string.");
    }
    return value.ctxId === undefined ? {} : { ctxId: value.ctxId };
}

function invalid(message: string): Error {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
