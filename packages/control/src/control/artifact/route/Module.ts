import type { PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../../server/Route.js";
import {
    readArtifactImageRef,
    readArtifactShareInput,
    readArtifactTransferStartInput,
    readArtifactViewImageInput,
    readDefaultInstance,
    readShareId,
    readTransferId
} from "./Input.js";
import type { ArtifactService } from "../Service.js";

export function createArtifactRouteModule(service?: ArtifactService): PrefixRouteModuleDefinition {
    const artifact = () => requirePort(service, "Artifact service is not available.");
    return routeModule("artifact", {
        readImage: async (request) => await artifact().readImage(readArtifactImageRef(request.payload)) as never,
        viewImage: async (request) => await artifact().viewImage(
            readArtifactViewImageInput(request.payload),
            readDefaultInstance(request.payload)
        ) as never,
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
