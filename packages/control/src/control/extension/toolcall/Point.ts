import type {
    ExtensionPointDeclaration,
} from "@portable-devshell/extension";
import { review, rewrite } from "@portable-devshell/extension/toolcall";

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
): ExtensionPointDeclaration {
    const unknown = Object.keys(declaration).find((key) => key !== "id");
    if (unknown !== undefined)
        throw new TypeError(
            `ToolCall Extension Point declaration has unknown field ${unknown}.`,
        );
    return Object.freeze({ id: declaration.id });
}
