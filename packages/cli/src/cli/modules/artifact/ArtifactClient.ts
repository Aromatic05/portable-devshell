import {
    controlClientModule,
    type ArtifactShareInput,
    type ArtifactShareResult,
    type ArtifactShareRevokeResult,
    type ArtifactTransferRecord,
    type ArtifactTransferResult,
    type ArtifactTransferStartInput,
    type ClientConnection
} from "@portable-devshell/shared";

import type { ArtifactCliClient } from "./ArtifactCommand.js";

export function createArtifactClient(connection: ClientConnection): ArtifactCliClient {
    const artifact = controlClientModule(connection, "artifact");
    return {
        createShare: (defaultInstance: string, input: ArtifactShareInput): Promise<ArtifactShareResult> =>
            artifact.request("createShare", { ...input, defaultInstance }),
        listShares: (): Promise<ArtifactShareResult[]> => artifact.request("listShares"),
        revokeShare: (shareId: string): Promise<ArtifactShareRevokeResult> =>
            artifact.request("revokeShare", { shareId }),
        startTransfer: (defaultInstance: string, input: ArtifactTransferStartInput): Promise<ArtifactTransferResult> =>
            artifact.request("startTransfer", { ...input, defaultInstance }),
        getTransfer: (transferId: string): Promise<ArtifactTransferRecord> =>
            artifact.request("getTransfer", { transferId }),
        listTransfers: (): Promise<ArtifactTransferRecord[]> => artifact.request("listTransfers"),
        cancelTransfer: (transferId: string): Promise<ArtifactTransferResult> =>
            artifact.request("cancelTransfer", { transferId })
    };
}

export type ArtifactClient = ReturnType<typeof createArtifactClient>;
