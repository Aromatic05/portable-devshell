import type { IncomingMessage, ServerResponse } from "node:http";

import type { InstanceRegistry } from "../instance/Api.js";
import type {
    ArtifactImageContent,
    ArtifactSnapshot,
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactTargetDescriptor,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
    ControlConfig,
    ControlPathHome,
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

export interface ArtifactImageApi {
    readImage(imageRef: string): Promise<ArtifactImageContent>;
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
    cancelTransfer(transferId: string): Promise<ArtifactTransferResult>;
    waitForTransfer(transferId: string): Promise<ArtifactTransferRecord>;
}

export interface ArtifactRouteApi extends ArtifactImageApi, ArtifactManagementApi {
    snapshot(): ArtifactSnapshot;
    subscribe(
        stream: MessageStream,
        fromSeq: number,
        signal?: AbortSignal,
    ): Promise<void>;
}

export interface ArtifactApi extends ArtifactRouteApi {
    retireInstance(instance: string): Promise<void>;
}

export interface ArtifactRuntime {
    readonly service: ArtifactApi;
    installHttpRoute(server: ArtifactHttpHost, publicBaseUrl?: string): () => void;
    start(): Promise<void>;
    stop(): Promise<void>;
    transferHostPath(
        sourcePath: string,
        target: ArtifactTargetDescriptor,
        overwrite?: boolean,
        signal?: AbortSignal,
    ): Promise<ArtifactTransferRecord>;
}
