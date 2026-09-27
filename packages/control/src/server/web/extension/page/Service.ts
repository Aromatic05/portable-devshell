import {
    pages,
    type WebPageBinding,
    type WebPageRequest,
} from "@portable-devshell/extension/web";
import type {
    WebPageDescriptor,
    WebPageSnapshot,
} from "@portable-devshell/shared";

import type { ExtensionHost } from "../../../../control/extension/Host.js";
import { WebExtensionPageCatalog } from "./Catalog.js";
import { validateWebPageSnapshot } from "./Snapshot.js";

export class WebExtensionPageService {
    readonly #catalog: WebExtensionPageCatalog;
    readonly #extensions: Pick<ExtensionHost, "acquireRegistration">;

    constructor(
        extensions: Pick<
            ExtensionHost,
            "acquireRegistration" | "listDeclarations"
        >,
    ) {
        this.#extensions = extensions;
        this.#catalog = new WebExtensionPageCatalog(extensions);
    }

    list(): readonly WebPageDescriptor[] {
        return this.#catalog.list();
    }

    async invoke(
        pageId: string,
        request: WebPageRequest,
        context: { requestId: string; signal: AbortSignal },
    ): Promise<WebPageSnapshot> {
        const acquired = await this.#extensions.acquireRegistration(pages.id, pageId);
        const { lease, registration } = acquired;
        try {
            if (typeof registration.binding !== "function")
                throw new TypeError(`Web page ${pageId} has an invalid binding.`);
            const snapshot = await (registration.binding as WebPageBinding)(
                request,
                Object.freeze(context),
            );
            return validateWebPageSnapshot(snapshot, pageId);
        } finally {
            lease.release();
        }
    }
}
