import {
    createError,
    errorCodes,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
    type JsonValue,
    type PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import { parseConversationPreferencesPatch } from "./ConversationPreferenceStore.js";

export interface ConversationPreferencePort {
    read(): Promise<ConversationPreferencesSnapshot>;
    update(patch: ConversationPreferencesPatch): Promise<ConversationPreferencesSnapshot>;
}

export function createConversationPreferenceRouteModule(
    port: ConversationPreferencePort,
): PrefixRouteModuleDefinition {
    return routeModule("conversation", {
        preferences: async () => await port.read() as unknown as JsonValue,
        updatePreferences: async (request) => await port.update(
            readConversationPreferencesPatch(request.payload ?? {}),
        ) as unknown as JsonValue,
    });
}

function readConversationPreferencesPatch(value: JsonValue): ConversationPreferencesPatch {
    try {
        return parseConversationPreferencesPatch(value);
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw createError({
            code: errorCodes.targetInvalid,
            message: error.message,
            retryable: false,
        });
    }
}
