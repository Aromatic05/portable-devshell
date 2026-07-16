import type { PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../common/RouteModule.js";
import {
    readArtifactShareInput,
    readArtifactTransferStartInput,
    readDefaultInstance,
    readShareId,
    readTransferId
} from "./ArtifactInput.js";
import type { ArtifactService } from "./ArtifactService.js";

export function createArtifactModule(service?: ArtifactService): PrefixRouteModuleDefinition {
    const artifact = () => requirePort(service, "Artifact service is not available.");
    return routeModule("artifact", {
        createShare: async (request) => await artifact().createShare(
            readArtifactShareInput(request.payload),
            readDefaultInstance(request.payload)
        ) as never,
        listShares: () => artifact().listShares() as never,
        revokeShare: async (request) => await artifact().revokeShare(readShareId(request.payload)) as never,
        startTransfer: async (request) => await artifact().startTransfer(
            readArtifactTransferStartInput(request.payload),
            readDefaultInstance(request.payload)
        ) as never,
        getTransfer: (request) => artifact().getTransfer(readTransferId(request.payload)) as never,
        listTransfers: () => artifact().listTransfers() as never,
        cancelTransfer: async (request) => await artifact().cancelTransfer(readTransferId(request.payload)) as never
    });
}
