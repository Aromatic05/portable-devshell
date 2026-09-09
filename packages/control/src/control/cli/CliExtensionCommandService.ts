import {
    modelCommands,
    nativeCommands,
    type CliCommandDeclaration,
    type CliCommandResult,
    type CliModelCommandBinding,
    type CliModelCommandInvocationContext,
    type CliNativeCommandBinding,
    type CliNativeCommandInvocationContext
} from "@portable-devshell/extension/cli";
import {
    createError,
    errorCodes,
    type CliCommandDescriptor
} from "@portable-devshell/shared";

import type { ExtensionHost } from "../extension/host/ExtensionHost.js";
import type {
    CliExtensionCommandInvocationContext,
    CliExtensionCommandIo,
    CliExtensionCommandProvider
} from "./CliExtensionCommandProvider.js";

export type CliExtensionCommandSurface = "model" | "native";

export interface CliExtensionCommandServiceOptions {
    providers?: readonly CliExtensionCommandProvider[];
    surface: CliExtensionCommandSurface;
}

export class CliExtensionCommandService {
    readonly #extensions: Pick<ExtensionHost, "acquireRegistration" | "listDeclarations">;
    readonly #pointId: string;
    readonly #providers: ReadonlyMap<string, CliExtensionCommandProvider>;
    readonly #surface: CliExtensionCommandSurface;

    constructor(
        extensions: Pick<ExtensionHost, "acquireRegistration" | "listDeclarations">,
        options: CliExtensionCommandServiceOptions
    ) {
        this.#extensions = extensions;
        this.#surface = options.surface;
        this.#pointId = options.surface === "native" ? nativeCommands.id : modelCommands.id;
        const indexed = new Map<string, CliExtensionCommandProvider>();
        for (const provider of options.providers ?? []) {
            if (provider.surface !== options.surface) {
                throw new TypeError(
                    `CLI ${provider.surface} provider ${provider.declaration.id} cannot register in ${options.surface} command state.`
                );
            }
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
        context: CliNativeCommandInvocationContext | CliModelCommandInvocationContext,
        io?: CliExtensionCommandIo
    ): Promise<CliCommandResult> {
        const provider = this.#providers.get(commandId);
        if (provider !== undefined) {
            return await provider.binding(argv, Object.freeze({
                ...context,
                surface: this.#surface,
                ...(io === undefined ? {} : { io })
            }) as CliExtensionCommandInvocationContext);
        }

        let acquired;
        try {
            acquired = await this.#extensions.acquireRegistration(this.#pointId, commandId);
        } catch {
            throw unavailable(commandId, this.#surface);
        }
        const { lease, registration } = acquired;
        try {
            if (typeof registration.binding !== "function") {
                throw createError({
                    code: errorCodes.controlCliCommandFailed,
                    details: { commandId, surface: this.#surface },
                    message: `CLI ${this.#surface} command ${commandId} has an invalid binding.`,
                    retryable: false
                });
            }
            if (this.#surface === "native") {
                return await (registration.binding as CliNativeCommandBinding)(
                    argv,
                    context as CliNativeCommandInvocationContext
                );
            }
            return await (registration.binding as CliModelCommandBinding)(
                argv,
                context as CliModelCommandInvocationContext
            );
        } finally {
            lease.release();
        }
    }

    has(commandId: string): boolean {
        return this.#providers.has(commandId)
            || this.#extensions.listDeclarations(this.#pointId).some(({ id }) => id === commandId);
    }

    list(): readonly CliCommandDescriptor[] {
        const resident = [...this.#providers.values()].map((provider) => descriptor(
            provider.extensionId,
            provider.declaration
        ));
        const sandboxed = this.#extensions.listDeclarations(this.#pointId).map((registration) => {
            const declaration = registration.declaration as CliCommandDeclaration;
            return descriptor(registration.extensionId, declaration);
        });
        return [...resident, ...sandboxed].sort((left, right) =>
            left.id.localeCompare(right.id) || left.extensionId.localeCompare(right.extensionId)
        );
    }
}

function unavailable(commandId: string, surface: CliExtensionCommandSurface): Error {
    return createError({
        code: errorCodes.controlCliCommandFailed,
        details: { commandId },
        message: `CLI command ${commandId} is unavailable.`,
        retryable: false
    });
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
