import {
    commands,
    parseCliCommandDeclaration,
    type CliCommandDeclaration
} from "@portable-devshell/extension/cli";
import type { ExtensionPointDeclaration } from "@portable-devshell/extension";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext
} from "../extension/host/generation/ExtensionPointRegistry.js";
import {
    createCliSandboxBinding,
    validateCliCommandBinding
} from "./CliExtensionSandboxCodec.js";

const BUILTIN_CLI_COMMAND_IDS = new Set([
    "approval",
    "artifact",
    "config",
    "context",
    "debug",
    "extension",
    "help",
    "instance",
    "logs",
    "oauth",
    "overview",
    "restart",
    "start",
    "status",
    "stop",
    "todo",
    "tool",
    "tui",
    "watch"
]);

export const cliCommandsExtensionPointDefinition: ExtensionPointDefinition = Object.freeze({
    createSandboxBinding: createCliSandboxBinding,
    id: commands.id,
    parseDeclaration(declaration: ExtensionPointDeclaration): CliCommandDeclaration {
        const parsed = parseCliCommandDeclaration(declaration);
        if (BUILTIN_CLI_COMMAND_IDS.has(parsed.id)) {
            throw new TypeError(`cli.commands/${parsed.id} conflicts with a built-in CLI command.`);
        }
        return parsed;
    },
    validateBinding(binding: unknown, context: ExtensionPointValidationContext) {
        validateCliCommandBinding(binding, context);
    }
});
