import type { WebApplicationDeclaration } from "@portable-devshell/extension/web";
import type { WebApplicationDescriptor } from "@portable-devshell/shared";

import type { ExtensionRuntime } from "../../../../extension/Public.js";

export class WebApplicationCatalog {
    readonly #extensions: Pick<ExtensionRuntime, "listDeclarations">;

    constructor(extensions: Pick<ExtensionRuntime, "listDeclarations">) {
        this.#extensions = extensions;
    }

    list(): readonly WebApplicationDescriptor[] {
        return this.#extensions
            .listDeclarations("web.applications")
            .map((registration) => {
                const declaration =
                    registration.declaration as WebApplicationDeclaration;
                return Object.freeze({
                    extensionId: registration.extensionId,
                    id: declaration.id,
                    title: declaration.title,
                });
            });
    }
}
