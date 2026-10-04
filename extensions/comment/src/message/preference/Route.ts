import { ExtensionError } from "@portable-devshell/extension";
import type {
    MessagePreferencesPatch,
    MessagePreferencesSnapshot,
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { parseMessagePreferencesPatch } from "./Model.js";

export interface MessagePreferencePort {
    read(): Promise<MessagePreferencesSnapshot>;
    update(
        patch: MessagePreferencesPatch,
    ): Promise<MessagePreferencesSnapshot>;
}

export function createMessagePreferenceRouteModule(
    port: MessagePreferencePort,
): ControlPortDefinition {
    return {
        name: "message",
        operations: [
            {
                name: "preferences",
                handle: async () => (await port.read()) as unknown as JsonValue,
            },
            {
                name: "updatePreferences",
                handle: async (request) =>
                    (await port.update(
                        readMessagePreferencesPatch(
                            request.payload ?? {},
                        ),
                    )) as unknown as JsonValue,
            },
        ],
    };
}

function readMessagePreferencesPatch(
    value: JsonValue,
): MessagePreferencesPatch {
    try {
        return parseMessagePreferencesPatch(value);
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new ExtensionError({
            code: "control.invalidTarget",
            message: error.message,
            retryable: false,
        });
    }
}
