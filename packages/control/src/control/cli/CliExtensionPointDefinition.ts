import {
    modelCommands,
    nativeCommands,
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
    createCliModelSandboxBinding,
    createCliNativeSandboxBinding,
    validateCliCommandBinding
} from "./CliExtensionSandboxCodec.js";

export const cliNativeCommandsExtensionPointDefinition: ExtensionPointDefinition = Object.freeze({
    createSandboxBinding: createCliNativeSandboxBinding,
    id: nativeCommands.id,
    parseDeclaration: (declaration: ExtensionPointDeclaration) => parseCliCommandDeclaration(declaration, nativeCommands.id),
    validateBinding(binding: unknown, context: ExtensionPointValidationContext) {
        validateCliCommandBinding(binding, context, nativeCommands.id);
    }
});

export const cliModelCommandsExtensionPointDefinition: ExtensionPointDefinition = Object.freeze({
    createSandboxBinding: createCliModelSandboxBinding,
    id: modelCommands.id,
    parseDeclaration: (declaration: ExtensionPointDeclaration) => parseCliCommandDeclaration(declaration, modelCommands.id),
    validateBinding(binding: unknown, context: ExtensionPointValidationContext) {
        validateCliCommandBinding(binding, context, modelCommands.id);
    }
});

function parseCliCommandDeclaration(
    value: ExtensionPointDeclaration,
    pointId: string
): CliCommandDeclaration {
    const record = value as ExtensionPointDeclaration & Record<string, ExtensionJsonValue | undefined>;
    const allowed = new Set(["id", "summary", "title", "usage"]);
    const unknown = Object.keys(record).find((key) => !allowed.has(key));
    if (unknown !== undefined) throw new TypeError(`${pointId} declaration has unknown field ${unknown}.`);
    return Object.freeze({
        id: value.id,
        ...(record.summary === undefined ? {} : { summary: readString(record.summary, "summary", pointId) }),
        title: readString(record.title, "title", pointId),
        ...(record.usage === undefined ? {} : { usage: readString(record.usage, "usage", pointId) })
    });
}

function readString(value: ExtensionJsonValue | undefined, field: string, pointId: string): string {
    if (typeof value === "string" && value.length > 0 && value.trim() === value) return value;
    throw new TypeError(`${pointId} declaration ${field} must be a non-empty trimmed string.`);
}
