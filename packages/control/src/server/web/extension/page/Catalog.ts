import {
    pages,
    type WebPageDeclaration,
} from "@portable-devshell/extension/web";
import type { WebPageDescriptor } from "@portable-devshell/shared";

import type { ExtensionHost } from "../../../../control/extension/Host.js";

export class WebExtensionPageCatalog {
    readonly #extensions: Pick<ExtensionHost, "listDeclarations">;

    constructor(extensions: Pick<ExtensionHost, "listDeclarations">) {
        this.#extensions = extensions;
    }

    list(): readonly WebPageDescriptor[] {
        return this.#extensions
            .listDeclarations(pages.id)
            .map((registration) => {
                const declaration = registration.declaration as WebPageDeclaration;
                return Object.freeze({
                    extensionId: registration.extensionId,
                    id: declaration.id,
                    title: declaration.title,
                });
            })
            .sort(
                (left, right) =>
                    left.title.localeCompare(right.title) ||
                    left.id.localeCompare(right.id),
            );
    }
}
