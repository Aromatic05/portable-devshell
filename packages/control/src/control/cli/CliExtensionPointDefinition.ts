import {
    commands,
    type CliCommandDeclaration
} from "@portable-devshell/extension/cli";
import type {
    ExtensionJsonValue,
    ExtensionPointDeclaration
} from "@portable-devshell/extension";

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

function parseCliCommandDeclaration(value: ExtensionPointDeclaration): CliCommandDeclaration {
    const record = value as ExtensionPointDeclaration & Record<string, ExtensionJsonValue | undefined>;
    const allowed = new Set(["id", "summary", "title", "usage"]);
    const unknown = Object.keys(record).find((key) => !allowed.has(key));
    if (unknown !== undefined) throw new TypeError(`cli.commands declaration has unknown field ${unknown}.`);
    return Object.freeze({
        id: value.id,
        ...(record.summary === undefined ? {} : { summary: readString(record.summary, "summary") }),
        title: readString(record.title, "title"),
        ...(record.usage === undefined ? {} : { usage: readString(record.usage, "usage") })
    });
}

function readString(value: ExtensionJsonValue | undefined, field: string): string {
    if (typeof value === "string" && value.length > 0 && value.trim() === value) return value;
    throw new TypeError(`cli.commands declaration ${field} must be a non-empty trimmed string.`);
}
