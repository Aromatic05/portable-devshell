import {
    modelCommands,
    nativeCommands,
    type CliCommandDeclaration,
    type CliCommandIo,
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

export type CliExtensionCommandSurface = "model" | "native";

export interface CliExtensionCommandServiceOptions {
    surface: CliExtensionCommandSurface;
}

export class CliExtensionCommandService {
    readonly #extensions: Pick<ExtensionHost, "acquireRegistration" | "listDeclarations">;
    readonly #pointId: string;
    readonly #surface: CliExtensionCommandSurface;

    constructor(
        extensions: Pick<ExtensionHost, "acquireRegistration" | "listDeclarations">,
        options: CliExtensionCommandServiceOptions
    ) {
        this.#extensions = extensions;
        this.#surface = options.surface;
        this.#pointId = options.surface === "native" ? nativeCommands.id : modelCommands.id;
    }

    async command(
        commandId: string,
        argv: readonly string[],
        context: CliNativeCommandInvocationContext | CliModelCommandInvocationContext,
        io?: CliCommandIo
    ): Promise<CliCommandResult> {
        let acquired;
        try {
            acquired = await this.#extensions.acquireRegistration(this.#pointId, commandId);
        } catch {
            throw unavailable(commandId);
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
                    Object.freeze({
                        ...context as CliNativeCommandInvocationContext,
                        ...(io === undefined ? {} : { io })
                    })
                );
            }
            return await (registration.binding as CliModelCommandBinding)(
                argv,
                Object.freeze({
                    ...context as CliModelCommandInvocationContext,
                    ...(io === undefined ? {} : { io })
                })
            );
        } finally {
            lease.release();
        }
    }

    has(commandId: string): boolean {
        return this.#extensions.listDeclarations(this.#pointId).some(({ id }) => id === commandId);
    }

    list(): readonly CliCommandDescriptor[] {
        return this.#extensions.listDeclarations(this.#pointId)
            .map((registration) => descriptor(
                registration.extensionId,
                registration.declaration as CliCommandDeclaration
            ))
            .sort((left, right) => left.id.localeCompare(right.id) || left.extensionId.localeCompare(right.extensionId));
    }
}

function unavailable(commandId: string): Error {
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
