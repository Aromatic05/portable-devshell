import {
    commands,
    parseCliCommandDeclaration
} from "@portable-devshell/extension/cli";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext
} from "../extension/host/generation/ExtensionPointRegistry.js";

export const cliCommandsExtensionPointDefinition: ExtensionPointDefinition = Object.freeze({
    id: commands.id,
    parseDeclaration: parseCliCommandDeclaration,
    validateBinding(binding: unknown, context: ExtensionPointValidationContext) {
        if (typeof binding !== "function") {
            throw new TypeError(
                `Extension ${context.extensionId} cli.commands/${context.id} binding must be a function.`
            );
        }
    }
});
