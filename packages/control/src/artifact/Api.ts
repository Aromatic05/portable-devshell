import type { IncomingMessage, ServerResponse } from "node:http";

import type { InstanceRegistry } from "@portable-devshell/core/instance";
import type {
    ExtensionAssetProjectionInput,
    ExtensionAssetProjectionResult,
} from "@portable-devshell/extension/asset";
import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactPayloadChunk,
    ArtifactStoredImageResult,
    ArtifactTransferCancelInput,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
    ControlConfig,
    ControlPathHome,
    JsonValue,
    MessageStream,
} from "@portable-devshell/shared";

export interface ArtifactHttpHost {
    registerRawRoute(
        method: "delete" | "get" | "head" | "options" | "post",
        path: string,
        handler: (
            request: IncomingMessage,
            response: ServerResponse,
        ) => void | Promise<void>,
    ): () => void;
}

export interface ArtifactExtensionTransferInput {
    overwrite?: boolean;
    signal?: AbortSignal;
    sourcePath: string;
    target: { instance: string; path: string; workspace: string };
}

export interface ArtifactProjectionInput {
    overwrite?: boolean;
    signal?: AbortSignal;
    sourcePath: string;
    target: ExtensionAssetProjectionInput["target"];
}

export interface ArtifactRuntimeOptions {
    config: () => ControlConfig;
    controlPaths: ControlPathHome;
    homeDirectory?: string;
    instances: InstanceRegistry;
}

export interface ArtifactDirectoryManifestResult {
    entryCount: number;
    logicalBytes: number;
    manifestBlake3: string;
}

export interface ArtifactDirectoryArchiveLimits {
    maxEntries?: number;
    maxFileBytes?: number;
    maxLogicalBytes?: number;
}

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
    ): Promise<ArtifactPayloadChunk>;
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

export interface ArtifactRuntime {
    readonly service: ArtifactApi;
    installHttpRoute(server: ArtifactHttpHost): void;
    projectExtensionAsset(
        extensionId: string,
        input: ArtifactProjectionInput,
    ): Promise<ExtensionAssetProjectionResult>;
    start(): Promise<void>;
    stop(): Promise<void>;
    transferExtensionAsset(
        extensionId: string,
        input: ArtifactExtensionTransferInput,
    ): Promise<ExtensionAssetProjectionResult>;
}
