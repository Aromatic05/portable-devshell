import { randomUUID } from "node:crypto";

import {
    createError,
    errorCodes,
    isArtifactTransferTerminal,
    recoverArtifactTransferStatus,
    type ArtifactEventType,
    type ArtifactTransferCancelInput,
    type ArtifactTransferLookupInput,
    type ArtifactTransferRecord,
    type ArtifactTransferResult,
    type ArtifactTransferStartInput,
    type JsonValue
} from "@portable-devshell/shared";

import { ArtifactRecordStore } from "./ArtifactRecordStore.js";
import {
    readSourceInstance,
    readTransferPayloadSourceInput,
    validateTransferStart
} from "./ArtifactSource.js";
import {
    ARTIFACT_RECORD_VERSION,
    DEFAULT_ARTIFACT_CHUNK_BYTES,
    requireArtifactEndpoint,
    type ArtifactServiceEndpoint,
    type ArtifactServiceOptions,
    type StoredArtifactTransfer
} from "./ArtifactServiceModel.js";
import { ArtifactTransferExecutor } from "./ArtifactTransferExecutor.js";

export interface ArtifactTransferServiceOptions {
    chunkBytes?: number;
    recordStore: ArtifactRecordStore;
    resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    schedule?: ArtifactServiceOptions["schedule"];
}

export class ArtifactTransferService {
    readonly #recordStore: ArtifactRecordStore;
    readonly #resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    readonly #transferExecutor: ArtifactTransferExecutor;
    readonly #transfers = new Map<string, StoredArtifactTransfer>();
    readonly #transferWaiters = new Map<
        string,
        Set<(record: ArtifactTransferRecord) => void>
    >();
    #generation = 0;
    #initialized = false;

    constructor(options: ArtifactTransferServiceOptions) {
        const chunkBytes = options.chunkBytes ?? DEFAULT_ARTIFACT_CHUNK_BYTES;
        if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
            throw new TypeError("Artifact chunkBytes must be a positive integer.");
        }

        this.#recordStore = options.recordStore;
        this.#resolveEndpoint = options.resolveEndpoint;
        this.#transferExecutor = new ArtifactTransferExecutor({
            chunkBytes,
            emitTransferEvent: async (transfer, type) => {
                await this.#emitTransferEvent(transfer, type);
            },
            getTransfer: (transferId) => this.#transfers.get(transferId),
            isRunActive: (generation) => {
                return this.#initialized && this.#generation === generation;
            },
            onTerminal: (record) => this.#resolveTransferWaiters(record),
            persistTransfer: async (transfer) => {
                await this.#recordStore.persistTransfer(transfer);
            },
            resolveEndpoint: options.resolveEndpoint,
            schedule: options.schedule ?? ((task) => queueMicrotask(task))
        });
    }

    async initialize(): Promise<void> {
        this.#generation += 1;
        this.#transfers.clear();

        for (const transfer of await this.#recordStore.loadTransfers()) {
            this.#transfers.set(transfer.record.transferId, transfer);
        }

        this.#initialized = true;
        for (const transfer of this.#transfers.values()) {
            const recovered = recoverArtifactTransferStatus(transfer.record.status);
            if (recovered === "queued") {
                this.#scheduleTransfer(transfer.record.transferId);
                continue;
            }
            if (recovered === transfer.record.status) {
                continue;
            }

            transfer.record.status = "interrupted";
            transfer.record.completedAt = new Date().toISOString();
            transfer.record.updatedAt = transfer.record.completedAt;
            transfer.record.failure = {
                code: errorCodes.artifactTransferInterrupted,
                message: "Artifact transfer was interrupted by control restart.",
                retryable: true
            };
            await this.#recordStore.persistTransfer(transfer);
            await this.#transferExecutor.cleanupResources(transfer);
            await this.#emitTransferEvent(
                transfer,
                "artifact.transferInterrupted"
            );
            this.#resolveTransferWaiters(transfer.record);
        }
    }

    async stop(): Promise<void> {
        if (!this.#initialized) return;

        this.#initialized = false;
        this.#generation += 1;
        for (const transfer of this.#transfers.values()) {
            if (
                transfer.record.status === "queued" ||
                isArtifactTransferTerminal(transfer.record.status)
            ) {
                continue;
            }

            const now = new Date().toISOString();
            transfer.record.status = "interrupted";
            transfer.record.completedAt = now;
            transfer.record.updatedAt = now;
            transfer.record.failure = {
                code: errorCodes.artifactTransferInterrupted,
                message: "Artifact transfer was interrupted by control shutdown.",
                retryable: true
            };
            await this.#recordStore.persistTransfer(transfer);
            await this.#transferExecutor.cleanupResources(transfer);
            await this.#emitTransferEvent(
                transfer,
                "artifact.transferInterrupted"
            );
            this.#resolveTransferWaiters(transfer.record);
        }
    }

    async startTransfer(
        input: ArtifactTransferStartInput,
        defaultInstance: string
    ): Promise<ArtifactTransferResult> {
        this.#assertInitialized();
        validateTransferStart(input);
        const sourceInstance = readSourceInstance(input.instance, defaultInstance);
        requireArtifactEndpoint(
            this.#resolveEndpoint,
            sourceInstance,
            defaultInstance
        );
        requireArtifactEndpoint(
            this.#resolveEndpoint,
            input.targetInstance,
            defaultInstance
        );

        const now = new Date().toISOString();
        const transferId = randomUUID();
        const sourceInput = readTransferPayloadSourceInput(input);
        const record: ArtifactTransferRecord = {
            createdAt: now,
            source: {
                ...sourceInput,
                instance: sourceInstance
            },
            status: "queued",
            target: {
                instance: input.targetInstance,
                path: input.targetPath
            },
            transferId,
            transferredBytes: 0,
            updatedAt: now
        };
        const stored: StoredArtifactTransfer = {
            cancelRequested: false,
            defaultInstance,
            record,
            request: { ...input },
            version: ARTIFACT_RECORD_VERSION
        };

        this.#transfers.set(transferId, stored);
        await this.#recordStore.persistTransfer(stored);
        this.#scheduleTransfer(transferId);
        return {
            operation: "start",
            transfer: structuredClone(record)
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
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    async lookupTransfer(
        input: ArtifactTransferLookupInput
    ): Promise<ArtifactTransferResult> {
        return {
            operation: "status",
            transfer: this.getTransfer(input.transferId)
        };
    }

    async cancelTransfer(
        input: ArtifactTransferCancelInput | string
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
                transfer: structuredClone(transfer.record)
            };
        }

        transfer.cancelRequested = true;
        const now = new Date().toISOString();
        if (transfer.record.status === "queued") {
            transfer.record.status = "cancelled";
            transfer.record.completedAt = now;
            transfer.record.updatedAt = now;
            await this.#recordStore.persistTransfer(transfer);
            await this.#emitTransferEvent(
                transfer,
                "artifact.transferCancelled"
            );
            this.#resolveTransferWaiters(transfer.record);
        } else {
            transfer.record.status = "cancelling";
            transfer.record.updatedAt = now;
            await this.#recordStore.persistTransfer(transfer);
        }

        return {
            operation: "cancel",
            transfer: structuredClone(transfer.record)
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

    #scheduleTransfer(transferId: string): void {
        this.#transferExecutor.schedule(transferId, this.#generation);
    }

    async #emitTransferEvent(
        transfer: StoredArtifactTransfer,
        type: ArtifactEventType
    ): Promise<void> {
        const sourceEndpoint = this.#resolveEndpoint(
            transfer.record.source.instance,
            transfer.defaultInstance
        );
        const targetEndpoint = this.#resolveEndpoint(
            transfer.record.target.instance,
            transfer.defaultInstance
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

    #assertInitialized(): void {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
    }
}

async function emitToEndpoint(
    endpoint: ArtifactServiceEndpoint,
    type: ArtifactEventType,
    data?: JsonValue
): Promise<void> {
    await endpoint.appendControlEvent(type, data).catch(() => undefined);
}

function transferNotFound(transferId: string) {
    return createError({
        code: errorCodes.artifactTransferNotFound,
        message: "Artifact transfer was not found.",
        retryable: false,
        details: { transferId }
    });
}

function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}
