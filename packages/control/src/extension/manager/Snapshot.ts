import type { ExtensionCatalogSnapshot, ExtensionSnapshot } from "@portable-devshell/shared";

import type { ExtensionHost } from "../host/Host.js";

export function readExtensionSnapshot(
    host: Pick<ExtensionHost, "readPublicState">,
    catalogs: () => ExtensionCatalogSnapshot,
): Promise<ExtensionSnapshot> {
    return host.readPublicState(({ extensions, revision }) => ({
        ...catalogs(),
        extensions,
        revision,
    }));
}
