import {
    controlClientModule,
    type ArtifactShareResult,
    type ArtifactShareRevokeResult,
    type ArtifactTransferRecord,
    type ArtifactTransferResult,
    type ClientConnection
} from "@portable-devshell/shared";

export function createTuiClientArtifact(connection: ClientConnection) {
    const artifact = controlClientModule(connection, "artifact");
    return {
        listShares: (): Promise<ArtifactShareResult[]> => artifact.request("listShares"),
        revokeShare: (shareId: string): Promise<ArtifactShareRevokeResult> =>
            artifact.request("revokeShare", { shareId }),
        listTransfers: (): Promise<ArtifactTransferRecord[]> => artifact.request("listTransfers"),
        cancelTransfer: (transferId: string): Promise<ArtifactTransferResult> =>
            artifact.request("cancelTransfer", { transferId })
    };
}

export type TuiClientArtifact = ReturnType<typeof createTuiClientArtifact>;
