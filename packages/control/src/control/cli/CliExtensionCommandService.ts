import type { ExtensionInvocationContext } from "@portable-devshell/extension";
import type {
    CliCommandDeclaration,
    CliCommandResult
} from "@portable-devshell/extension/cli";
import type { CliCommandDescriptor } from "@portable-devshell/shared";

import type { ExtensionHost } from "../extension/host/ExtensionHost.js";

export class CliExtensionCommandService {
    readonly #extensions: Pick<ExtensionHost, "dispatchCommand" | "listDeclarations">;

    constructor(extensions: Pick<ExtensionHost, "dispatchCommand" | "listDeclarations">) {
        this.#extensions = extensions;
    }

    async command(
        commandId: string,
        argv: readonly string[],
        context: ExtensionInvocationContext
    ): Promise<CliCommandResult> {
        return await this.#extensions.dispatchCommand(commandId, argv, context);
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
