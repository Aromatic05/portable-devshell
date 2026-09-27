import {
    pages,
    type TuiPageDeclaration,
} from "@portable-devshell/extension/tui";
import type {
    ExtensionJsonValue,
    ExtensionPointDeclaration,
} from "@portable-devshell/extension";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext,
} from "../generation/registration/PointRegistry.js";
import { createTuiPageSandboxBinding, validateTuiPageBinding } from "./Sandbox.js";

export const tuiPagesExtensionPointDefinition: ExtensionPointDefinition =
    Object.freeze({
        createSandboxBinding: createTuiPageSandboxBinding,
        id: pages.id,
        parseDeclaration: parseTuiPageDeclaration,
        validateBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            validateTuiPageBinding(binding, context);
        },
    });

function parseTuiPageDeclaration(
    value: ExtensionPointDeclaration,
): TuiPageDeclaration {
    const record = value as ExtensionPointDeclaration &
        Record<string, ExtensionJsonValue | undefined>;
    const unknown = Object.keys(record).find(
        (key) => key !== "id" && key !== "title",
    );
    if (unknown !== undefined)
        throw new TypeError(`tui.pages declaration has unknown field ${unknown}.`);
    if (
        typeof record.title !== "string" ||
        record.title.length === 0 ||
        record.title.trim() !== record.title
    ) {
        throw new TypeError(
            "tui.pages declaration title must be a non-empty trimmed string.",
        );
    }
    return Object.freeze({ id: value.id, title: record.title });
}
