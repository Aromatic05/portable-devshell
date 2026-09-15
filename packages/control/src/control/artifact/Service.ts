import type {
    WorkerArtifactDirectPushInput,
    WorkerArtifactDirectPushResult,
    WorkerArtifactDirectReceiveOpenInput,
    WorkerArtifactDirectReceiveOpenResult,
    WorkerArtifactPayloadOpenInput,
    WorkerArtifactPayloadOpenResult,
    WorkerArtifactPayloadReadInput,
    WorkerArtifactPayloadReadResult,
    WorkerArtifactReceiveBeginInput,
    WorkerArtifactReceiveBeginResult,
    WorkerArtifactReceiveFinishResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult,
} from "@portable-devshell/core";
import { createError, errorCodes } from "@portable-devshell/shared";
import type {
    ArtifactEventType,
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactShareRevokeResult,
    ArtifactStoredImageResult,
    ArtifactTransferCancelInput,
    ArtifactTransferLookupInput,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
    JsonValue,
} from "@portable-devshell/shared";
import { ArtifactRecordStore } from "./RecordStore.js";
import { ArtifactImageService } from "./delivery/Image.js";
import { ArtifactShareService } from "./delivery/Share.js";
import { ArtifactTransferService } from "./delivery/Transfer.js";

export class ArtifactService {
    readonly #imageService: ArtifactImageService;
    readonly #recordStore: ArtifactRecordStore;
    readonly #shareService: ArtifactShareService;
    readonly #transferService: ArtifactTransferService;
    #initialized = false;

    constructor(options: ArtifactServiceOptions) {
        const terminalHistoryLimit =
            options.terminalHistoryLimit ??
            DEFAULT_ARTIFACT_TERMINAL_HISTORY_LIMIT;
        if (
            !Number.isSafeInteger(terminalHistoryLimit) ||
            terminalHistoryLimit < 0
        ) {
            throw new TypeError(
                "Artifact terminalHistoryLimit must be a non-negative safe integer.",
            );
        }
        this.#imageService = new ArtifactImageService(options);
        this.#recordStore = new ArtifactRecordStore(options.storageDir);
        this.#shareService = new ArtifactShareService({
            recordStore: this.#recordStore,
            resolveEndpoint: options.resolveEndpoint,
            shareUrl: options.shareUrl,
            terminalHistoryLimit,
        });
        this.#transferService = new ArtifactTransferService({
            chunkBytes: options.chunkBytes,
            directTransfer: options.directTransfer,
            recordStore: this.#recordStore,
            resolveEndpoint: options.resolveEndpoint,
            schedule: options.schedule,
            terminalHistoryLimit,
        });
    }

    async initialize(): Promise<void> {
        if (this.#initialized) {
            return;
        }

        await this.#imageService.initialize();
        await this.#recordStore.initialize();
        await this.#shareService.initialize();
        await this.#transferService.initialize();
        this.#initialized = true;
    }

    async stop(): Promise<void> {
        if (!this.#initialized) {
            return;
        }

        this.#initialized = false;
        this.#shareService.stop();
        await this.#transferService.stop();
    }

    async viewImage(
        input: ArtifactViewImageInput,
        defaultInstance: string,
        signal?: AbortSignal,
    ): Promise<ArtifactViewImageResult> {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
        return await this.#imageService.view(input, defaultInstance, signal);
    }

    async readImage(imageRef: string): Promise<ArtifactStoredImageResult> {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
        return await this.#imageService.read(imageRef);
    }

    async createShare(
        input: ArtifactShareInput,
        defaultInstance: string,
    ): Promise<ArtifactShareResult> {
        return await this.#shareService.createShare(input, defaultInstance);
    }

    listShares(): ArtifactShareResult[] {
        return this.#shareService.listShares();
    }

    async revokeShare(shareId: string): Promise<ArtifactShareRevokeResult> {
        return await this.#shareService.revokeShare(shareId);
    }

    async resolveShare(token: string): Promise<ArtifactShareAccess> {
        return await this.#shareService.resolveShare(token);
    }

    async beginShareDownload(token: string): Promise<ArtifactShareAccess> {
        return await this.#shareService.beginShareDownload(token);
    }

    async readSharePayload(
        access: ArtifactShareAccess,
        offsetBytes: number,
        maxBytes: number,
    ): Promise<WorkerArtifactPayloadReadResult> {
        return await this.#shareService.readSharePayload(
            access,
            offsetBytes,
            maxBytes,
        );
    }

    async finishShareDownload(
        token: string,
        completed: boolean,
        details?: JsonValue,
    ): Promise<void> {
        await this.#shareService.finishShareDownload(token, completed, details);
    }

    async retireInstance(instance: string): Promise<void> {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
        await this.#shareService.retireInstance(instance);
        await this.#transferService.retireInstance(instance);
    }

    async startTransfer(
        input: ArtifactTransferStartInput,
        defaultInstance: string,
    ): Promise<ArtifactTransferResult> {
        return await this.#transferService.startTransfer(
            input,
            defaultInstance,
        );
    }

    getTransfer(transferId: string): ArtifactTransferRecord {
        return this.#transferService.getTransfer(transferId);
    }

    listTransfers(): ArtifactTransferRecord[] {
        return this.#transferService.listTransfers();
    }

    async lookupTransfer(
        input: ArtifactTransferLookupInput,
    ): Promise<ArtifactTransferResult> {
        return await this.#transferService.lookupTransfer(input);
    }

    async cancelTransfer(
        input: ArtifactTransferCancelInput | string,
    ): Promise<ArtifactTransferResult> {
        return await this.#transferService.cancelTransfer(input);
    }

    async waitForTransfer(transferId: string): Promise<ArtifactTransferRecord> {
        return await this.#transferService.waitForTransfer(transferId);
    }
}

export const ARTIFACT_RECORD_VERSION = 1;

export const DEFAULT_ARTIFACT_CHUNK_BYTES = 512 * 1024;

export const DEFAULT_ARTIFACT_SHARE_TTL_SECONDS = 60 * 60;

export const MAX_ARTIFACT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

export const ARTIFACT_TRANSFER_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_ARTIFACT_TERMINAL_HISTORY_LIMIT = 256;

export type ArtifactServiceSchedule = (task: () => void) => void;

export interface ArtifactServiceEndpoint {
    abortArtifactReceive(receiveId: string): Promise<void>;
    appendControlEvent(
        type: ArtifactEventType,
        data?: JsonValue,
    ): Promise<unknown>;
    beginArtifactReceive(
        input: WorkerArtifactReceiveBeginInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveBeginResult>;
    closeArtifactPayload(payloadId: string): Promise<void>;
    finishArtifactReceive(
        receiveId: string,
    ): Promise<WorkerArtifactReceiveFinishResult>;
    openArtifactPayload(
        input: WorkerArtifactPayloadOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadOpenResult>;
    readArtifactPayload(
        input: WorkerArtifactPayloadReadInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactPayloadReadResult>;
    writeArtifactReceive(
        input: WorkerArtifactReceiveWriteInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactReceiveWriteResult>;
    openArtifactDirectReceive?(
        input: WorkerArtifactDirectReceiveOpenInput,
        signal?: AbortSignal,
    ): Promise<WorkerArtifactDirectReceiveOpenResult>;
    closeArtifactDirectReceive?(receiverId: string): Promise<void>;
    pushArtifactPayloadDirect?(
        input: WorkerArtifactDirectPushInput,
    ): Promise<WorkerArtifactDirectPushResult>;
}

export interface ArtifactServiceOptions {
    chunkBytes?: number;
    directTransfer?: boolean;
    resolveEndpoint: (
        instance: string,
        authorityInstance?: string,
    ) => ArtifactServiceEndpoint | undefined;
    schedule?: ArtifactServiceSchedule;
    shareUrl: (token: string) => string;
    storageDir: string;
    terminalHistoryLimit?: number;
}

export function requireArtifactEndpoint(
    resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"],
    instance: string,
    authorityInstance: string,
): ArtifactServiceEndpoint {
    const endpoint = resolveEndpoint(instance, authorityInstance);
    if (endpoint !== undefined) {
        return endpoint;
    }

    throw createError({
        code: errorCodes.instanceMissing,
        message: `Instance ${instance} was not found.`,
        retryable: false,
        details: { instance },
    });
}

export interface StoredArtifactShare {
    authorityInstance: string;
    payloadClosed: boolean;
    payloadId: string;
    result: ArtifactShareResult;
    sourceInstance: string;
    terminalAtMs?: number;
    token: string;
    version: number;
}

export interface StoredArtifactTransfer {
    cancelRequested: boolean;
    defaultInstance: string;
    payloadId?: string;
    receiveId?: string;
    record: ArtifactTransferRecord;
    request: ArtifactTransferStartInput;
    version: number;
}

export interface ArtifactShareAccess {
    payloadId: string;
    share: ArtifactShareResult;
    sourceInstance: string;
}

export type ArtifactPayloadSourceInput =
    { handle: string } | { path: string; workspace: string };
