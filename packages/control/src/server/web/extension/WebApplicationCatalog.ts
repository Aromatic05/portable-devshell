import type { WebApplicationDeclaration } from "@portable-devshell/extension/web";
import type { WebApplicationDescriptor } from "@portable-devshell/shared";

import type { ExtensionHost } from "../../../control/extension/host/ExtensionHost.js";

export class WebApplicationCatalog {
    readonly #extensions: Pick<ExtensionHost, "listDeclarations">;

    constructor(extensions: Pick<ExtensionHost, "listDeclarations">) {
        this.#extensions = extensions;
    }

    list(): readonly WebApplicationDescriptor[] {
        return this.#extensions.listDeclarations("web.applications").map((registration) => {
            const declaration = registration.declaration as WebApplicationDeclaration;
            return Object.freeze({
                extensionId: registration.extensionId,
                id: declaration.id,
                title: declaration.title
            });
        });
    }
}
