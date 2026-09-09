import type {
    CliCommandBinding,
    CliCommandDeclaration,
    CliCommandInvocationContext,
    CliCommandResult
} from "@portable-devshell/extension/cli";
import {
    createError,
    errorCodes,
    type CliCommandDescriptor
} from "@portable-devshell/shared";

import type { ExtensionHost } from "../extension/host/ExtensionHost.js";

export class CliExtensionCommandService {
    readonly #extensions: Pick<ExtensionHost, "acquireRegistration" | "listDeclarations">;

    constructor(extensions: Pick<ExtensionHost, "acquireRegistration" | "listDeclarations">) {
        this.#extensions = extensions;
    }

    async command(
        commandId: string,
        argv: readonly string[],
        context: CliCommandInvocationContext
    ): Promise<CliCommandResult> {
        let acquired;
        try {
            acquired = await this.#extensions.acquireRegistration("cli.commands", commandId);
        } catch {
            throw createError({
                code: errorCodes.controlCliCommandFailed,
                details: { commandId },
                message: `CLI command ${commandId} is unavailable.`,
                retryable: false
            });
        }
        const { lease, registration } = acquired;
        try {
            if (typeof registration.binding !== "function") {
                throw createError({
                    code: errorCodes.controlCliCommandFailed,
                    details: { commandId },
                    message: `CLI command ${commandId} has an invalid binding.`,
                    retryable: false
                });
            }
            return await (registration.binding as CliCommandBinding)(argv, context);
        } finally {
            lease.release();
        }
    }

    list(): readonly CliCommandDescriptor[] {
        return this.#extensions.listDeclarations("cli.commands").map((registration) => {
            const declaration = registration.declaration as CliCommandDeclaration;
            return Object.freeze({
                extensionId: registration.extensionId,
                id: declaration.id,
                ...(declaration.summary === undefined ? {} : { summary: declaration.summary }),
                title: declaration.title,
                ...(declaration.usage === undefined ? {} : { usage: declaration.usage })
            });
        });
    }
}
