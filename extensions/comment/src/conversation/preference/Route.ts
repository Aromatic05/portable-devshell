import {
    createError,
    errorCodes,
    type ConversationPreferencesPatch,
    type ConversationPreferencesSnapshot,
    type JsonValue,
    type PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";

import { parseConversationPreferencesPatch } from "./Model.js";

export interface ConversationPreferencePort {
    read(): Promise<ConversationPreferencesSnapshot>;
    update(
        patch: ConversationPreferencesPatch,
    ): Promise<ConversationPreferencesSnapshot>;
}

export function createConversationPreferenceRouteModule(
    port: ConversationPreferencePort,
): PrefixRouteModuleDefinition {
    return {
        name: "conversation",
        operations: [
            {
                name: "preferences",
                handle: async () => (await port.read()) as unknown as JsonValue,
            },
            {
                name: "updatePreferences",
                handle: async (request) =>
                    (await port.update(
                        readConversationPreferencesPatch(
                            request.payload ?? {},
                        ),
                    )) as unknown as JsonValue,
            },
        ],
    };
}

function readConversationPreferencesPatch(
    value: JsonValue,
): ConversationPreferencesPatch {
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
