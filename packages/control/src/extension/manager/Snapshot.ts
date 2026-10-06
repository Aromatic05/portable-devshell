import type { ExtensionCatalogSnapshot, ExtensionSnapshot } from "@portable-devshell/shared";

import type { ExtensionRuntime } from "../Api.js";

export function readExtensionSnapshot(
    host: Pick<ExtensionRuntime, "readPublicState">,
    catalogs: () => ExtensionCatalogSnapshot,
): Promise<ExtensionSnapshot> {
    return host.readPublicState(({ extensions, revision }) => ({
        ...catalogs(),
        extensions,
        revision,
    }));
}
