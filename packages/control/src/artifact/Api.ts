import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactStoredImageResult,
    ArtifactTransferCancelInput,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
    JsonValue,
    MessageStream,
    WorkerArtifactPayloadReadResult,
} from "@portable-devshell/shared";

export interface ArtifactSnapshot {
    lastSeq: number;
    shares: ArtifactShareResult[];
    transfers: ArtifactTransferRecord[];
}

export interface ArtifactShareAccess {
    payloadId: string;
    share: ArtifactShareResult;
    sourceInstance: string;
}

export interface ArtifactImageApi {
    readImage(imageRef: string): Promise<ArtifactStoredImageResult>;
    viewImage(
        input: ArtifactViewImageInput,
        defaultInstance: string,
        signal?: AbortSignal,
    ): Promise<ArtifactViewImageResult>;
}

export interface ArtifactManagementApi {
    createShare(
        input: ArtifactShareInput,
        defaultInstance: string,
    ): Promise<ArtifactShareResult>;
    listShares(): ArtifactShareResult[];
    revokeShare(shareId: string): Promise<ArtifactShareRevokeResult>;
    startTransfer(
        input: ArtifactTransferStartInput,
        defaultInstance: string,
    ): Promise<ArtifactTransferResult>;
    getTransfer(transferId: string): ArtifactTransferRecord;
    listTransfers(): ArtifactTransferRecord[];
    cancelTransfer(
        input: ArtifactTransferCancelInput | string,
    ): Promise<ArtifactTransferResult>;
    waitForTransfer(transferId: string): Promise<ArtifactTransferRecord>;
}

export interface ArtifactShareHttpApi {
    resolveShare(token: string): Promise<ArtifactShareAccess>;
    beginShareDownload(token: string): Promise<ArtifactShareAccess>;
    readSharePayload(
        access: ArtifactShareAccess,
        offsetBytes: number,
        maxBytes: number,
    ): Promise<WorkerArtifactPayloadReadResult>;
    finishShareDownload(
        token: string,
        completed: boolean,
        details?: JsonValue,
    ): Promise<void>;
}

export interface ArtifactRouteApi extends ArtifactImageApi, ArtifactManagementApi {
    snapshot(): ArtifactSnapshot;
    subscribe(
        stream: MessageStream,
        fromSeq: number,
        signal?: AbortSignal,
    ): Promise<void>;
}

export interface ArtifactApi
    extends ArtifactRouteApi,
        ArtifactShareHttpApi {
    retireInstance(instance: string): Promise<void>;
}
