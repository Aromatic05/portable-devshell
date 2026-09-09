import type { CliCommandDeclaration } from "@portable-devshell/extension/cli";
import type { CliCommandDescriptor } from "@portable-devshell/shared";

import type { ExtensionHost } from "../extension/host/ExtensionHost.js";

export class CliExtensionCommandCatalog {
    readonly #extensions: Pick<ExtensionHost, "listDeclarations">;

    constructor(extensions: Pick<ExtensionHost, "listDeclarations">) {
        this.#extensions = extensions;
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
