import type {
    ExtensionPointDeclaration,
} from "@portable-devshell/extension";
import {
    review,
    rewrite,
    type ToolCallExtensionDeclaration,
} from "@portable-devshell/extension/toolcall";

import type {
    ExtensionPointDefinition,
    ExtensionPointValidationContext,
} from "../generation/registration/PointRegistry.js";
import {
    createToolCallReviewSandboxBinding,
    createToolCallRewriteSandboxBinding,
    validateToolCallReviewBinding,
    validateToolCallRewriteBinding,
} from "./Sandbox.js";

export const toolCallReviewExtensionPointDefinition: ExtensionPointDefinition =
    Object.freeze({
        createSandboxBinding: createToolCallReviewSandboxBinding,
        id: review.id,
        parseDeclaration,
        validateBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            validateToolCallReviewBinding(binding, context);
        },
    });

export const toolCallRewriteExtensionPointDefinition: ExtensionPointDefinition =
    Object.freeze({
        createSandboxBinding: createToolCallRewriteSandboxBinding,
        id: rewrite.id,
        parseDeclaration,
        validateBinding(
            binding: unknown,
            context: ExtensionPointValidationContext,
        ) {
            validateToolCallRewriteBinding(binding, context);
        },
    });

function parseDeclaration(
    declaration: ExtensionPointDeclaration,
): ToolCallExtensionDeclaration {
    const unknown = Object.keys(declaration).find(
        (key) => key !== "hook" && key !== "id",
    );
    if (unknown !== undefined)
        throw new TypeError(
            `ToolCall Extension Point declaration has unknown field ${unknown}.`,
        );
    const hook = declaration.hook;
    if (
        typeof hook !== "string" ||
        !/^(?!000)[0-9]{3}-[a-z][a-z0-9-]*$/u.test(hook)
    ) {
        throw new TypeError(
            "ToolCall hook must match NNN-name with a priority from 001 through 999.",
        );
    }
    return Object.freeze({ hook, id: declaration.id });
}
