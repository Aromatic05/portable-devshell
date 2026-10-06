import {
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";
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
    ArtifactPayloadChunk,
    JsonValue,
    MessageStream,
    WorkerArtifactApi,
} from "@portable-devshell/shared";
import {
    ArtifactEventLog,
    DEFAULT_ARTIFACT_EVENT_HISTORY_LIMIT,
} from "./EventLog.js";
import { ArtifactRecordStore } from "./RecordStore.js";
import { ArtifactImageService } from "./delivery/Image.js";
import { ArtifactShareService } from "./delivery/Share.js";
import { ArtifactTransferService } from "./delivery/Transfer.js";
import type {
    ArtifactApi,
    ArtifactShareAccess,
    ArtifactSnapshot,
} from "./Api.js";

export class ArtifactService implements ArtifactApi {
    readonly #eventLog: ArtifactEventLog;
    readonly #imageService: ArtifactImageService;
    readonly #recordStore: ArtifactRecordStore;
    readonly #shareService: ArtifactShareService;
    readonly #transferService: ArtifactTransferService;
    #initialized = false;
    #cleanupPending = false;

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
        this.#eventLog = new ArtifactEventLog(
            options.eventHistoryLimit ?? DEFAULT_ARTIFACT_EVENT_HISTORY_LIMIT,
        );
        this.#imageService = new ArtifactImageService(options);
        this.#recordStore = new ArtifactRecordStore(options.storageDir);
        this.#shareService = new ArtifactShareService({
            recordEvent: (instance, type, data) =>
                this.#recordEvent(instance, type, data),
            recordStore: this.#recordStore,
            resolveEndpoint: options.resolveEndpoint,
            shareUrl: options.shareUrl,
            terminalHistoryLimit,
        });
        this.#transferService = new ArtifactTransferService({
            chunkBytes: options.chunkBytes,
            directTransfer: options.directTransfer,
            recordEvent: (instance, type, data) =>
                this.#recordEvent(instance, type, data),
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

        if (this.#cleanupPending) await this.stop();
        this.#cleanupPending = true;
        this.#eventLog.reset();

        try {
            await this.#imageService.initialize();
            await this.#recordStore.initialize();
            await this.#shareService.initialize();
            await this.#transferService.initialize();
            this.#initialized = true;
            this.#cleanupPending = false;
        } catch (error) {
            this.#initialized = false;
            this.#shareService.stop();
            try {
                await this.#transferService.stop();
                this.#cleanupPending = false;
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Artifact service initialization failed and cleanup was incomplete.",
                );
            }
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (!this.#initialized && !this.#cleanupPending) {
            return;
        }

        this.#initialized = false;
        this.#cleanupPending = true;
        this.#eventLog.close();
        this.#shareService.stop();
        await this.#transferService.stop();
        this.#cleanupPending = false;
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
    ): Promise<ArtifactPayloadChunk> {
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

    /**
     * Captures the authoritative shares, transfers, and global event cursor in
     * one synchronous read. Because reads and event recording never interleave
     * inside a single tick, a subscriber that resumes from `lastSeq + 1` sees
     * every event that is not already reflected in this snapshot.
     */
    snapshot(): ArtifactSnapshot {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
        return {
            lastSeq: this.#eventLog.lastSeq,
            shares: this.#shareService.listShares(),
            transfers: this.#transferService.listTransfers(),
        };
    }

    /**
     * Serves one cursor-resumable artifact event stream: an initial seed (or a
     * stream.gap when the cursor fell out of the bounded replay window), then
     * live events as they are recorded. The handler stays pending until the
     * client closes the stream or aborts.
     */
    async subscribe(
        stream: MessageStream,
        fromSeq: number,
        signal?: AbortSignal,
    ): Promise<void> {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
        let cursor = Math.max(1, fromSeq);
        const initial = this.#eventLog.read(cursor);
        if (initial.kind === "gap") {
            await stream.send({
                name: "gap",
                payload: {
                    latestSeq: initial.lastSeq,
                    oldestAvailableSeq: initial.nextSeq,
                    requestedFromSeq: cursor,
                },
                seq: initial.lastSeq,
            });
            cursor = initial.nextSeq;
        } else {
            await stream.send({
                name: "seed",
                payload: {
                    events: initial.events as unknown as JsonValue,
                    lastSeq: initial.lastSeq,
                },
            });
            cursor = initial.lastSeq + 1;
        }

        let closed = false;
        let wake: (() => void) | undefined;
        const unsubscribe = this.#eventLog.subscribe(() => wake?.());
        const onClose = () => {
            closed = true;
            wake?.();
        };
        stream.onClose(onClose);
        stream.onCancel(onClose);
        const onAbort = () => {
            closed = true;
            wake?.();
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            while (!closed && !this.#eventLog.closed) {
                const slice = this.#eventLog.read(cursor);
                if (slice.kind === "gap") {
                    await stream.send({
                        name: "gap",
                        payload: {
                            latestSeq: slice.lastSeq,
                            oldestAvailableSeq: slice.nextSeq,
                            requestedFromSeq: cursor,
                        },
                        seq: slice.lastSeq,
                    });
                    cursor = slice.nextSeq;
                    continue;
                }
                if (slice.events.length > 0) {
                    for (const event of slice.events) {
                        await stream.send({
                            name: "event",
                            payload: event as unknown as JsonValue,
                            seq: event.seq,
                        });
                        cursor = event.seq + 1;
                        if (closed) break;
                    }
                    continue;
                }
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    if (
                        closed ||
                        this.#eventLog.closed ||
                        this.#eventLog.lastSeq >= cursor
                    ) {
                        wake = undefined;
                        resolve();
                    }
                });
                wake = undefined;
            }
        } catch {
            // The client closed the stream or a send failed; stop serving it.
        } finally {
            unsubscribe();
            signal?.removeEventListener("abort", onAbort);
        }
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

    #recordEvent(
        instance: string,
        type: ArtifactEventType,
        data?: JsonValue,
    ): void {
        this.#eventLog.record(instance, type, data);
    }
}

export const ARTIFACT_RECORD_VERSION = 1;

export const DEFAULT_ARTIFACT_CHUNK_BYTES = 2 * 1024 * 1024;

export const DEFAULT_ARTIFACT_SHARE_TTL_SECONDS = 60 * 60;

export const MAX_ARTIFACT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

export const ARTIFACT_TRANSFER_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_ARTIFACT_TERMINAL_HISTORY_LIMIT = 256;

export type ArtifactServiceSchedule = (task: () => void) => void;

export interface ArtifactServiceOptions {
    chunkBytes?: number;
    directTransfer?: boolean;
    eventHistoryLimit?: number;
    resolveEndpoint: (
        instance: string,
        authorityInstance?: string,
    ) => WorkerArtifactApi | undefined;
    schedule?: ArtifactServiceSchedule;
    shareUrl: (token: string) => string;
    storageDir: string;
    terminalHistoryLimit?: number;
}

/** Records one logical artifact event into the global sequence. */
export type ArtifactEventRecorder = (
    instance: string,
    type: ArtifactEventType,
    data?: JsonValue,
) => void;

export function requireArtifactEndpoint(
    resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"],
    instance: string,
    authorityInstance: string,
): WorkerArtifactApi {
    const endpoint = resolveEndpoint(instance, authorityInstance);
    if (endpoint !== undefined) {
        return endpoint;
    }

    throw createRemoteError({
        code: controlErrorCodes.instanceNotFound,
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

export type ArtifactPayloadSourceInput =
    { handle: string } | { path: string; workspace: string };
