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

import type { CliClientArtifactPort } from "../../command/artifact/CliCommandArtifact.js";

export function createCliClientArtifact(connection: ClientConnection): CliClientArtifactPort {
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

export type CliClientArtifact = ReturnType<typeof createCliClientArtifact>;
