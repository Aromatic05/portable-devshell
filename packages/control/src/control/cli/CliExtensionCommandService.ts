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
import type { CliExtensionCommandProvider } from "./CliExtensionCommandProvider.js";

export class CliExtensionCommandService {
    readonly #extensions: Pick<ExtensionHost, "acquireRegistration" | "listDeclarations">;
    readonly #providers: ReadonlyMap<string, CliExtensionCommandProvider>;

    constructor(
        extensions: Pick<ExtensionHost, "acquireRegistration" | "listDeclarations">,
        providers: readonly CliExtensionCommandProvider[] = []
    ) {
        this.#extensions = extensions;
        const indexed = new Map<string, CliExtensionCommandProvider>();
        for (const provider of providers) {
            if (indexed.has(provider.declaration.id)) {
                throw new TypeError(`CLI command provider ${provider.declaration.id} is registered more than once.`);
            }
            indexed.set(provider.declaration.id, provider);
        }
        this.#providers = indexed;
    }

    async command(
        commandId: string,
        argv: readonly string[],
        context: CliCommandInvocationContext
    ): Promise<CliCommandResult> {
        const provider = this.#providers.get(commandId);
        if (provider !== undefined) {
            return await provider.binding(argv, context);
        }

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
        const resident = [...this.#providers.values()].map((provider) => descriptor(
            provider.extensionId,
            provider.declaration
        ));
        const sandboxed = this.#extensions.listDeclarations("cli.commands").map((registration) => {
            const declaration = registration.declaration as CliCommandDeclaration;
            return descriptor(registration.extensionId, declaration);
        });
        return [...resident, ...sandboxed].sort((left, right) =>
            left.id.localeCompare(right.id) || left.extensionId.localeCompare(right.extensionId)
        );
    }
}

function descriptor(extensionId: string, declaration: CliCommandDeclaration): CliCommandDescriptor {
    return Object.freeze({
        extensionId,
        id: declaration.id,
        ...(declaration.summary === undefined ? {} : { summary: declaration.summary }),
        title: declaration.title,
        ...(declaration.usage === undefined ? {} : { usage: declaration.usage })
    });
}
