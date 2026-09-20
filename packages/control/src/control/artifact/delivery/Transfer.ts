import { randomUUID } from "node:crypto";
import {
    createError,
    errorCodes,
    isArtifactTransferTerminal,
    recoverArtifactTransferStatus,
    toControlErrorBody,
} from "@portable-devshell/shared";
import type {
    ArtifactEventType,
    ArtifactTransferCancelInput,
    ArtifactTransferFailure,
    ArtifactTransferLookupInput,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
    JsonValue,
} from "@portable-devshell/shared";
import { ArtifactRecordStore } from "../RecordStore.js";
import {
    readSourceInstance,
    readTransferPayloadSourceInput,
    sourceTypeFromPayload,
    validateTransferStart,
} from "../Source.js";
import {
    ARTIFACT_RECORD_VERSION,
    ARTIFACT_TRANSFER_PAYLOAD_TTL_MS,
    DEFAULT_ARTIFACT_CHUNK_BYTES,
    requireArtifactEndpoint,
} from "../Service.js";
import type {
    ArtifactServiceEndpoint,
    ArtifactServiceOptions,
    ArtifactServiceSchedule,
    StoredArtifactTransfer,
} from "../Service.js";
import type { WorkerArtifactPayloadReadResult } from "@portable-devshell/core";

export interface ArtifactTransferServiceOptions {
    chunkBytes?: number;
    directTransfer?: boolean;
    recordStore: ArtifactRecordStore;
    resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    schedule?: ArtifactServiceOptions["schedule"];
    terminalHistoryLimit: number;
}

export class ArtifactTransferService {
    readonly #recordStore: ArtifactRecordStore;
    readonly #resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    readonly #terminalHistoryLimit: number;
    readonly #transferExecutor: ArtifactTransferExecutor;
    readonly #transfers = new Map<string, StoredArtifactTransfer>();
    readonly #transferWaiters = new Map<
        string,
        Set<(record: ArtifactTransferRecord) => void>
    >();
    #generation = 0;
    #initialized = false;
    #cleanupPending = false;

    constructor(options: ArtifactTransferServiceOptions) {
        const chunkBytes = options.chunkBytes ?? DEFAULT_ARTIFACT_CHUNK_BYTES;
        if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
            throw new TypeError(
                "Artifact chunkBytes must be a positive integer.",
            );
        }

        this.#recordStore = options.recordStore;
        this.#resolveEndpoint = options.resolveEndpoint;
        this.#terminalHistoryLimit = options.terminalHistoryLimit;
        this.#transferExecutor = new ArtifactTransferExecutor({
            chunkBytes,
            directTransfer: options.directTransfer ?? false,
            emitTransferEvent: async (transfer, type) => {
                await this.#emitTransferEvent(transfer, type);
            },
            getTransfer: (transferId) => this.#transfers.get(transferId),
            isRunActive: (generation) => {
                return this.#initialized && this.#generation === generation;
            },
            onTerminal: async (record) => await this.#finalizeTerminal(record),
            persistTransfer: async (transfer) => {
                await this.#recordStore.persistTransfer(transfer);
            },
            resolveEndpoint: options.resolveEndpoint,
            schedule: options.schedule ?? ((task) => queueMicrotask(task)),
        });
    }

    async initialize(): Promise<void> {
        if (this.#cleanupPending) await this.stop();
        this.#cleanupPending = true;
        this.#generation += 1;
        this.#transfers.clear();

        for (const transfer of await this.#recordStore.loadTransfers()) {
            this.#transfers.set(transfer.record.transferId, transfer);
        }

        this.#initialized = true;
        try {
            for (const transfer of this.#transfers.values()) {
                const recovered = recoverArtifactTransferStatus(
                    transfer.record.status,
                );
                if (recovered === "queued") {
                    this.#scheduleTransfer(transfer.record.transferId);
                    continue;
                }
                if (recovered === transfer.record.status) {
                    continue;
                }

                await this.#mutateAndPersist(transfer, () => {
                    transfer.record.status = "interrupted";
                    transfer.record.completedAt = new Date().toISOString();
                    transfer.record.updatedAt = transfer.record.completedAt;
                    transfer.record.failure = {
                        code: errorCodes.artifactTransferInterrupted,
                        message:
                            "Artifact transfer was interrupted by control restart.",
                        retryable: true,
                    };
                });
                await this.#transferExecutor.cleanupResources(transfer);
                await this.#emitTransferEvent(
                    transfer,
                    "artifact.transferInterrupted",
                );
                await this.#finalizeTerminal(transfer.record);
            }
            await this.#compactTerminalHistory();
            this.#cleanupPending = false;
        } catch (error) {
            this.#initialized = false;
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (!this.#initialized && !this.#cleanupPending) return;

        this.#initialized = false;
        this.#cleanupPending = true;
        this.#generation += 1;
        this.#transferExecutor.cancelAll("Artifact service stopped.");
        await this.#transferExecutor.waitForCommits();
        for (const transfer of this.#transfers.values()) {
            if (
                transfer.record.status === "queued" ||
                isArtifactTransferTerminal(transfer.record.status)
            ) {
                continue;
            }

            const now = new Date().toISOString();
            await this.#mutateAndPersist(transfer, () => {
                transfer.record.status = "interrupted";
                transfer.record.completedAt = now;
                transfer.record.updatedAt = now;
                transfer.record.failure = {
                    code: errorCodes.artifactTransferInterrupted,
                    message:
                        "Artifact transfer was interrupted by control shutdown.",
                    retryable: true,
                };
            });
            await this.#transferExecutor.cleanupResources(transfer);
            await this.#emitTransferEvent(
                transfer,
                "artifact.transferInterrupted",
            );
            await this.#finalizeTerminal(transfer.record);
        }
        this.#cleanupPending = false;
    }

    async startTransfer(
        input: ArtifactTransferStartInput,
        defaultInstance: string,
    ): Promise<ArtifactTransferResult> {
        this.#assertInitialized();
        validateTransferStart(input);
        const sourceInstance = readSourceInstance(
            input.instance,
            defaultInstance,
        );
        requireArtifactEndpoint(
            this.#resolveEndpoint,
            sourceInstance,
            defaultInstance,
        );
        requireArtifactEndpoint(
            this.#resolveEndpoint,
            input.targetInstance,
            defaultInstance,
        );

        const now = new Date().toISOString();
        const transferId = randomUUID();
        const sourceInput = readTransferPayloadSourceInput(input);
        const record: ArtifactTransferRecord = {
            createdAt: now,
            source: {
                ...sourceInput,
                instance: sourceInstance,
            },
            status: "queued",
            target: {
                instance: input.targetInstance,
                path: input.targetPath,
                workspace: input.targetWorkspace,
            },
            transferId,
            transferredBytes: 0,
            updatedAt: now,
        };
        const stored: StoredArtifactTransfer = {
            cancelRequested: false,
            defaultInstance,
            record,
            request: { ...input },
            version: ARTIFACT_RECORD_VERSION,
        };

        await this.#recordStore.persistTransfer(stored);
        this.#transfers.set(transferId, stored);
        this.#scheduleTransfer(transferId);
        return {
            operation: "start",
            transfer: structuredClone(record),
        };
    }

    getTransfer(transferId: string): ArtifactTransferRecord {
        this.#assertInitialized();
        const transfer = this.#transfers.get(transferId);
        if (transfer === undefined) {
            throw transferNotFound(transferId);
        }
        return structuredClone(transfer.record);
    }

    listTransfers(): ArtifactTransferRecord[] {
        this.#assertInitialized();
        return [...this.#transfers.values()]
            .map((transfer) => structuredClone(transfer.record))
            .sort((left, right) =>
                right.createdAt.localeCompare(left.createdAt),
            );
    }

    async retireInstance(instance: string): Promise<void> {
        this.#assertInitialized();
        const transferIds = [...this.#transfers.values()]
            .filter(
                (transfer) =>
                    !isArtifactTransferTerminal(transfer.record.status) &&
                    (transfer.defaultInstance === instance ||
                        transfer.record.source.instance === instance ||
                        transfer.record.target.instance === instance),
            )
            .map((transfer) => transfer.record.transferId);
        for (const transferId of transferIds) {
            await this.cancelTransfer(transferId);
            await this.#waitForTerminalOrRemoval(transferId);
        }
    }

    async lookupTransfer(
        input: ArtifactTransferLookupInput,
    ): Promise<ArtifactTransferResult> {
        return {
            operation: "status",
            transfer: this.getTransfer(input.transferId),
        };
    }

    async cancelTransfer(
        input: ArtifactTransferCancelInput | string,
    ): Promise<ArtifactTransferResult> {
        this.#assertInitialized();
        const transferId = typeof input === "string" ? input : input.transferId;
        const transfer = this.#transfers.get(transferId);
        if (transfer === undefined) {
            throw transferNotFound(transferId);
        }
        if (isArtifactTransferTerminal(transfer.record.status)) {
            return {
                operation: "cancel",
                transfer: structuredClone(transfer.record),
            };
        }

        const now = new Date().toISOString();
        if (transfer.record.status === "queued") {
            await this.#mutateAndPersist(transfer, () => {
                transfer.cancelRequested = true;
                transfer.record.status = "cancelled";
                transfer.record.completedAt = now;
                transfer.record.updatedAt = now;
            });
            await this.#emitTransferEvent(
                transfer,
                "artifact.transferCancelled",
            );
            await this.#finalizeTerminal(transfer.record);
        } else {
            await this.#mutateAndPersist(transfer, () => {
                transfer.cancelRequested = true;
                transfer.record.status = "cancelling";
                transfer.record.updatedAt = now;
            });
            this.#transferExecutor.cancel(transferId);
        }

        return {
            operation: "cancel",
            transfer: structuredClone(transfer.record),
        };
    }

    async waitForTransfer(transferId: string): Promise<ArtifactTransferRecord> {
        const current = this.getTransfer(transferId);
        if (isArtifactTransferTerminal(current.status)) {
            return current;
        }

        return await new Promise<ArtifactTransferRecord>((resolve) => {
            const waiters = this.#transferWaiters.get(transferId) ?? new Set();
            waiters.add(resolve);
            this.#transferWaiters.set(transferId, waiters);
        });
    }

    async #waitForTerminalOrRemoval(transferId: string): Promise<void> {
        const current = this.#transfers.get(transferId);
        if (
            current === undefined ||
            isArtifactTransferTerminal(current.record.status)
        )
            return;
        await new Promise<void>((resolve) => {
            const waiters = this.#transferWaiters.get(transferId) ?? new Set();
            waiters.add(() => resolve());
            this.#transferWaiters.set(transferId, waiters);
        });
    }

    #scheduleTransfer(transferId: string): void {
        this.#transferExecutor.schedule(transferId, this.#generation);
    }

    async #emitTransferEvent(
        transfer: StoredArtifactTransfer,
        type: ArtifactEventType,
    ): Promise<void> {
        const sourceEndpoint = this.#resolveEndpoint(
            transfer.record.source.instance,
            transfer.defaultInstance,
        );
        const targetEndpoint = this.#resolveEndpoint(
            transfer.record.target.instance,
            transfer.defaultInstance,
        );
        const data = toJsonValue(transfer.record);

        if (sourceEndpoint !== undefined) {
            await emitToEndpoint(sourceEndpoint, type, data);
        }
        if (targetEndpoint !== undefined && targetEndpoint !== sourceEndpoint) {
            await emitToEndpoint(targetEndpoint, type, data);
        }
    }

    #resolveTransferWaiters(record: ArtifactTransferRecord): void {
        const waiters = this.#transferWaiters.get(record.transferId);
        if (waiters === undefined) return;

        this.#transferWaiters.delete(record.transferId);
        const cloned = structuredClone(record);
        for (const resolve of waiters) {
            resolve(cloned);
        }
    }

    async #finalizeTerminal(record: ArtifactTransferRecord): Promise<void> {
        await this.#compactTerminalHistory();
        this.#resolveTransferWaiters(record);
    }

    async #compactTerminalHistory(): Promise<void> {
        const terminal = [...this.#transfers.values()]
            .filter((transfer) =>
                isArtifactTransferTerminal(transfer.record.status),
            )
            .sort((left, right) => {
                const leftAt = left.record.completedAt ?? left.record.updatedAt;
                const rightAt =
                    right.record.completedAt ?? right.record.updatedAt;
                const terminalAt = leftAt.localeCompare(rightAt);
                return terminalAt === 0
                    ? left.record.createdAt.localeCompare(
                          right.record.createdAt,
                      )
                    : terminalAt;
            });
        while (terminal.length > this.#terminalHistoryLimit) {
            const transfer = terminal.shift()!;
            try {
                await this.#recordStore.deleteTransfer(
                    transfer.record.transferId,
                );
            } catch {
                return;
            }
            this.#transfers.delete(transfer.record.transferId);
        }
    }

    async #mutateAndPersist(
        transfer: StoredArtifactTransfer,
        mutate: () => void,
    ): Promise<void> {
        const previous = structuredClone(transfer);
        mutate();
        try {
            await this.#recordStore.persistTransfer(transfer);
        } catch (error) {
            restoreStoredTransfer(transfer, previous);
            throw error;
        }
    }

    #assertInitialized(): void {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
    }
}

function restoreStoredTransfer(
    target: StoredArtifactTransfer,
    previous: StoredArtifactTransfer,
): void {
    target.cancelRequested = previous.cancelRequested;
    target.defaultInstance = previous.defaultInstance;
    target.record = structuredClone(previous.record);
    target.request = structuredClone(previous.request);
    target.version = previous.version;
    if (previous.payloadId === undefined) delete target.payloadId;
    else target.payloadId = previous.payloadId;
    if (previous.receiveId === undefined) delete target.receiveId;
    else target.receiveId = previous.receiveId;
}

async function emitToEndpoint(
    endpoint: ArtifactServiceEndpoint,
    type: ArtifactEventType,
    data?: JsonValue,
): Promise<void> {
    await endpoint.appendControlEvent(type, data).catch(() => undefined);
}

function transferNotFound(transferId: string) {
    return createError({
        code: errorCodes.artifactTransferNotFound,
        message: "Artifact transfer was not found.",
        retryable: false,
        details: { transferId },
    });
}

function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

interface ArtifactTransferExecutorOptions {
    chunkBytes: number;
    directTransfer: boolean;
    emitTransferEvent: (
        transfer: StoredArtifactTransfer,
        type: ArtifactEventType,
    ) => Promise<void>;
    getTransfer: (transferId: string) => StoredArtifactTransfer | undefined;
    isRunActive: (generation: number) => boolean;
    onTerminal: (record: ArtifactTransferRecord) => Promise<void>;
    persistTransfer: (transfer: StoredArtifactTransfer) => Promise<void>;
    resolveEndpoint: (
        instance: string,
        authorityInstance?: string,
    ) => ArtifactServiceEndpoint | undefined;
    schedule: ArtifactServiceSchedule;
}

class ArtifactTransferCancelledError extends Error {
    constructor() {
        super("Artifact transfer was cancelled.");
    }
}

class ArtifactServiceStoppedError extends Error {
    constructor() {
        super("Artifact service generation is no longer active.");
    }
}

export class ArtifactTransferExecutor {
    readonly #chunkBytes: number;
    readonly #directTransfer: boolean;
    readonly #emitTransferEvent: ArtifactTransferExecutorOptions["emitTransferEvent"];
    readonly #getTransfer: ArtifactTransferExecutorOptions["getTransfer"];
    readonly #isRunActive: ArtifactTransferExecutorOptions["isRunActive"];
    readonly #onTerminal: ArtifactTransferExecutorOptions["onTerminal"];
    readonly #persistTransfer: ArtifactTransferExecutorOptions["persistTransfer"];
    readonly #resolveEndpoint: ArtifactTransferExecutorOptions["resolveEndpoint"];
    readonly #schedule: ArtifactServiceSchedule;
    readonly #commitBarriers = new Set<Promise<void>>();
    readonly #controllers = new Map<string, AbortController>();
    readonly #runningTransfers = new Set<string>();

    constructor(options: ArtifactTransferExecutorOptions) {
        this.#chunkBytes = options.chunkBytes;
        this.#directTransfer = options.directTransfer;
        this.#emitTransferEvent = options.emitTransferEvent;
        this.#getTransfer = options.getTransfer;
        this.#isRunActive = options.isRunActive;
        this.#onTerminal = options.onTerminal;
        this.#persistTransfer = options.persistTransfer;
        this.#resolveEndpoint = options.resolveEndpoint;
        this.#schedule = options.schedule;
    }

    schedule(transferId: string, generation: number): void {
        this.#schedule(() => {
            void this.#run(transferId, generation).catch(() => undefined);
        });
    }

    async waitForCommits(): Promise<void> {
        if (this.#commitBarriers.size === 0) return;
        await Promise.all([...this.#commitBarriers]);
    }

    cancel(
        transferId: string,
        reason = "Artifact transfer was cancelled.",
    ): void {
        this.#controllers.get(transferId)?.abort(reason);
    }

    cancelAll(reason = "Artifact service stopped."): void {
        for (const controller of this.#controllers.values()) {
            controller.abort(reason);
        }
    }

    async cleanupResources(transfer: StoredArtifactTransfer): Promise<void> {
        const sourceEndpoint = this.#resolveEndpoint(
            transfer.record.source.instance,
            transfer.defaultInstance,
        );
        const targetEndpoint = this.#resolveEndpoint(
            transfer.record.target.instance,
            transfer.defaultInstance,
        );
        if (transfer.receiveId !== undefined && targetEndpoint !== undefined) {
            await targetEndpoint
                .abortArtifactReceive(transfer.receiveId)
                .catch(() => undefined);
            transfer.receiveId = undefined;
        }
        await this.#closePayload(transfer, sourceEndpoint);
        await this.#persistTransfer(transfer);
    }

    async #run(transferId: string, generation: number): Promise<void> {
        if (
            !this.#isRunActive(generation) ||
            this.#runningTransfers.has(transferId)
        ) {
            return;
        }
        const transfer = this.#getTransfer(transferId);
        if (transfer === undefined || transfer.record.status !== "queued") {
            return;
        }
        this.#runningTransfers.add(transferId);
        const controller = new AbortController();
        this.#controllers.set(transferId, controller);
        const signal = controller.signal;
        let sourceEndpoint: ArtifactServiceEndpoint | undefined;
        let targetEndpoint: ArtifactServiceEndpoint | undefined;
        let commitBarrier: Promise<void> | undefined;
        let resolveCommitBarrier: (() => void) | undefined;
        try {
            this.#throwIfCancelled(transfer);
            sourceEndpoint = requireArtifactEndpoint(
                this.#resolveEndpoint,
                transfer.record.source.instance,
                transfer.defaultInstance,
            );
            targetEndpoint = requireArtifactEndpoint(
                this.#resolveEndpoint,
                transfer.record.target.instance,
                transfer.defaultInstance,
            );
            const startedAt = new Date().toISOString();
            transfer.record.status = "preparing";
            transfer.record.startedAt = startedAt;
            transfer.record.updatedAt = startedAt;
            await this.#persistTransfer(transfer);
            this.#assertRunActive(generation);
            await this.#emitTransferEvent(transfer, "artifact.transferStarted");

            const sourceInput = readTransferPayloadSourceInput(
                transfer.request,
            );
            const opened = await sourceEndpoint.openArtifactPayload(
                {
                    ...sourceInput,
                    expiresAtMs: Date.now() + ARTIFACT_TRANSFER_PAYLOAD_TTL_MS,
                },
                signal,
            );
            transfer.payloadId = opened.payloadId;
            this.#assertRunActive(generation);
            transfer.record.payload = opened.descriptor;
            transfer.record.totalBytes = opened.descriptor.payloadBytes;
            transfer.record.source.type = sourceTypeFromPayload(
                opened.descriptor,
            );
            transfer.record.updatedAt = new Date().toISOString();
            await this.#persistTransfer(transfer);
            this.#assertRunActive(generation);
            this.#throwIfCancelled(transfer);

            const receive = await targetEndpoint.beginArtifactReceive(
                {
                    descriptor: opened.descriptor,
                    overwrite: transfer.request.overwrite ?? false,
                    targetPath: transfer.request.targetPath,
                    workspace: transfer.request.targetWorkspace,
                },
                signal,
            );
            transfer.receiveId = receive.receiveId;
            this.#assertRunActive(generation);
            transfer.record.status = "transferring";
            transfer.record.updatedAt = new Date().toISOString();
            await this.#persistTransfer(transfer);
            this.#assertRunActive(generation);

            let receiveId = receive.receiveId;
            let offsetBytes = receive.nextOffsetBytes;
            let directComplete = false;
            if (
                this.#directTransfer &&
                transfer.record.source.instance !==
                    transfer.record.target.instance &&
                sourceEndpoint.pushArtifactPayloadDirect !== undefined &&
                targetEndpoint.openArtifactDirectReceive !== undefined &&
                targetEndpoint.closeArtifactDirectReceive !== undefined
            ) {
                let receiverId: string | undefined;
                try {
                    const direct =
                        await targetEndpoint.openArtifactDirectReceive(
                            {
                                expiresAtMs: Date.now() + 5 * 60_000,
                                receiveId,
                            },
                            signal,
                        );
                    receiverId = direct.receiverId;
                    if (
                        direct.urls.length === 0 ||
                        direct.nextOffsetBytes !== offsetBytes
                    ) {
                        throw new Error(
                            "Artifact direct receiver returned invalid state.",
                        );
                    }
                    while (offsetBytes < opened.descriptor.payloadBytes) {
                        this.#throwIfCancelled(transfer);
                        const pushed =
                            await sourceEndpoint.pushArtifactPayloadDirect({
                                maxBytes: Math.min(
                                    this.#chunkBytes,
                                    opened.descriptor.payloadBytes -
                                        offsetBytes,
                                ),
                                offsetBytes,
                                payloadId: opened.payloadId,
                                urls: direct.urls,
                            });
                        this.#assertRunActive(generation);
                        if (
                            pushed.pushedBytes <= 0 ||
                            pushed.nextOffsetBytes !==
                                offsetBytes + pushed.pushedBytes ||
                            pushed.nextOffsetBytes >
                                opened.descriptor.payloadBytes
                        ) {
                            throw new Error(
                                "Artifact direct transfer returned an invalid offset.",
                            );
                        }
                        offsetBytes = pushed.nextOffsetBytes;
                        await this.#recordProgress(transfer, offsetBytes);
                        this.#assertRunActive(generation);
                    }
                    directComplete = true;
                } catch {
                    this.#throwIfCancelled(transfer);
                    this.#assertRunActive(generation);
                    if (receiverId !== undefined) {
                        await targetEndpoint
                            .closeArtifactDirectReceive(receiverId)
                            .catch(() => undefined);
                        receiverId = undefined;
                    }
                    await targetEndpoint.abortArtifactReceive(receiveId);
                    const restarted = await targetEndpoint.beginArtifactReceive(
                        {
                            descriptor: opened.descriptor,
                            overwrite: transfer.request.overwrite ?? false,
                            targetPath: transfer.request.targetPath,
                            workspace: transfer.request.targetWorkspace,
                        },
                        signal,
                    );
                    receiveId = restarted.receiveId;
                    transfer.receiveId = receiveId;
                    offsetBytes = restarted.nextOffsetBytes;
                    await this.#recordProgress(transfer, offsetBytes);
                    this.#assertRunActive(generation);
                } finally {
                    if (receiverId !== undefined) {
                        await targetEndpoint
                            .closeArtifactDirectReceive(receiverId)
                            .catch(() => undefined);
                    }
                }
            }

            if (!directComplete) {
                while (offsetBytes < opened.descriptor.payloadBytes) {
                    this.#throwIfCancelled(transfer);
                    const chunk = await sourceEndpoint.readArtifactPayload(
                        {
                            maxBytes: Math.min(
                                this.#chunkBytes,
                                opened.descriptor.payloadBytes - offsetBytes,
                            ),
                            offsetBytes,
                            payloadId: opened.payloadId,
                        },
                        signal,
                    );
                    this.#assertRunActive(generation);
                    validatePayloadChunk(
                        chunk,
                        offsetBytes,
                        opened.descriptor.payloadBytes,
                    );
                    const written = await targetEndpoint.writeArtifactReceive(
                        {
                            content: chunk.content,
                            offsetBytes,
                            receiveId,
                        },
                        signal,
                    );
                    this.#assertRunActive(generation);
                    if (
                        written.nextOffsetBytes !==
                        offsetBytes + chunk.returnedBytes
                    ) {
                        throw createError({
                            code: errorCodes.artifactPayloadInvalid,
                            message:
                                "Artifact receiver returned an unexpected offset.",
                            retryable: true,
                            details: {
                                actual: written.nextOffsetBytes,
                                expected: offsetBytes + chunk.returnedBytes,
                                transferId,
                            },
                        });
                    }
                    offsetBytes = written.nextOffsetBytes;
                    await this.#recordProgress(transfer, offsetBytes);
                    this.#assertRunActive(generation);
                }
            }

            this.#throwIfCancelled(transfer);
            transfer.record.status = "verifying";
            transfer.record.updatedAt = new Date().toISOString();
            await this.#persistTransfer(transfer);
            transfer.record.status = "committing";
            transfer.record.updatedAt = new Date().toISOString();
            await this.#persistTransfer(transfer);
            this.#assertRunActive(generation);
            commitBarrier = new Promise<void>((resolve) => {
                resolveCommitBarrier = resolve;
            });
            this.#commitBarriers.add(commitBarrier);
            const finished =
                await targetEndpoint.finishArtifactReceive(receiveId);
            if (
                finished.bytes !== opened.descriptor.payloadBytes ||
                finished.blake3 !== opened.descriptor.payloadBlake3
            ) {
                throw createError({
                    code: errorCodes.artifactPayloadInvalid,
                    message:
                        "Artifact receiver verification result does not match the source payload.",
                    retryable: false,
                    details: { transferId },
                });
            }
            await this.#closePayload(transfer, sourceEndpoint);

            transfer.receiveId = undefined;
            transfer.record.status = "completed";
            transfer.record.completedAt = new Date().toISOString();
            transfer.record.updatedAt = transfer.record.completedAt;
            transfer.record.transferredBytes = opened.descriptor.payloadBytes;
            await this.#persistTransfer(transfer);
            await this.#emitTransferEvent(
                transfer,
                "artifact.transferCompleted",
            );
            await this.#onTerminal(transfer.record);
        } catch (error) {
            if (
                !this.#isRunActive(generation) ||
                error instanceof ArtifactServiceStoppedError
            ) {
                await this.cleanupResources(transfer);
                return;
            }
            await this.#handleFailure(
                transfer,
                error,
                sourceEndpoint,
                targetEndpoint,
            );
        } finally {
            await this.#closePayload(transfer, sourceEndpoint);
            this.#runningTransfers.delete(transferId);
            this.#controllers.delete(transferId);
            if (commitBarrier !== undefined) {
                this.#commitBarriers.delete(commitBarrier);
                resolveCommitBarrier?.();
            }
        }
    }

    async #recordProgress(
        transfer: StoredArtifactTransfer,
        offsetBytes: number,
    ): Promise<void> {
        transfer.record.transferredBytes = offsetBytes;
        transfer.record.updatedAt = new Date().toISOString();
        await this.#persistTransfer(transfer);
        await this.#emitTransferEvent(transfer, "artifact.transferProgress");
    }

    async #handleFailure(
        transfer: StoredArtifactTransfer,
        error: unknown,
        sourceEndpoint?: ArtifactServiceEndpoint,
        targetEndpoint?: ArtifactServiceEndpoint,
    ): Promise<void> {
        if (transfer.receiveId !== undefined && targetEndpoint !== undefined) {
            await targetEndpoint
                .abortArtifactReceive(transfer.receiveId)
                .catch(() => undefined);
            transfer.receiveId = undefined;
        }
        const now = new Date().toISOString();
        if (
            error instanceof ArtifactTransferCancelledError ||
            transfer.cancelRequested
        ) {
            transfer.record.status = "cancelled";
            transfer.record.completedAt = now;
            transfer.record.updatedAt = now;
            transfer.record.failure = undefined;
            await this.#persistTransfer(transfer);
            await this.#emitTransferEvent(
                transfer,
                "artifact.transferCancelled",
            );
        } else {
            transfer.record.status = "failed";
            transfer.record.completedAt = now;
            transfer.record.updatedAt = now;
            transfer.record.failure = failureFromError(error);
            await this.#persistTransfer(transfer);
            await this.#emitTransferEvent(transfer, "artifact.transferFailed");
        }
        await this.#closePayload(transfer, sourceEndpoint);
        await this.#onTerminal(transfer.record);
    }

    async #closePayload(
        transfer: StoredArtifactTransfer,
        sourceEndpoint = this.#resolveEndpoint(transfer.record.source.instance),
    ): Promise<void> {
        if (transfer.payloadId === undefined || sourceEndpoint === undefined) {
            return;
        }
        const payloadId = transfer.payloadId;
        try {
            await sourceEndpoint.closeArtifactPayload(payloadId);
            transfer.payloadId = undefined;
            await this.#persistTransfer(transfer);
        } catch {
            // Keep the persisted payload id for restart cleanup.
        }
    }

    #throwIfCancelled(transfer: StoredArtifactTransfer): void {
        if (
            transfer.cancelRequested ||
            transfer.record.status === "cancelling"
        ) {
            throw new ArtifactTransferCancelledError();
        }
    }

    #assertRunActive(generation: number): void {
        if (!this.#isRunActive(generation)) {
            throw new ArtifactServiceStoppedError();
        }
    }
}

function validatePayloadChunk(
    chunk: WorkerArtifactPayloadReadResult,
    expectedOffset: number,
    totalBytes: number,
): void {
    if (
        chunk.offsetBytes !== expectedOffset ||
        chunk.totalBytes !== totalBytes ||
        chunk.returnedBytes <= 0 ||
        chunk.returnedBytes > totalBytes - expectedOffset
    ) {
        throw createError({
            code: errorCodes.artifactPayloadInvalid,
            message: "Artifact source returned an invalid payload chunk.",
            retryable: true,
        });
    }
}

function failureFromError(error: unknown): ArtifactTransferFailure {
    const body = toControlErrorBody(error);
    if (body !== undefined) {
        return {
            code: body.code,
            message: body.message,
            retryable: body.retryable,
        };
    }
    return {
        code: errorCodes.coreProviderFailed,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
    };
}
