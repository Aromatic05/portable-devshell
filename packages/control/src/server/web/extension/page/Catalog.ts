import {
    pages,
    type WebPageDeclaration,
} from "@portable-devshell/extension/web";
import type { WebPageDescriptor } from "@portable-devshell/shared";

import type { ExtensionRuntime } from "../../../../extension/Public.js";

export class WebExtensionPageCatalog {
    readonly #extensions: Pick<ExtensionRuntime, "listDeclarations">;

    constructor(extensions: Pick<ExtensionRuntime, "listDeclarations">) {
        this.#extensions = extensions;
    }

    list(): readonly WebPageDescriptor[] {
        return this.#extensions
            .listDeclarations(pages.id)
            .map((registration) => {
                const declaration =
                    registration.declaration as WebPageDeclaration;
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
