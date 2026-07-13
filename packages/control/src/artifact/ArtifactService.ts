import { randomBytes, randomUUID } from "node:crypto";

import type { WorkerArtifactPayloadReadResult } from "@portable-devshell/core";
import {
    createError,
    errorCodes,
    isArtifactTransferTerminal,
    recoverArtifactTransferStatus,
    type ArtifactEventType,
    type ArtifactShareInput,
    type ArtifactShareResult,
    type ArtifactShareRevokeResult,
    type ArtifactTransferCancelInput,
    type ArtifactTransferLookupInput,
    type ArtifactTransferRecord,
    type ArtifactTransferResult,
    type ArtifactTransferStartInput,
    type JsonValue
} from "@portable-devshell/shared";

import { ArtifactRecordStore } from "./ArtifactRecordStore.js";
import {
    readSharePayloadSourceInput,
    readSourceInstance,
    readTransferPayloadSourceInput,
    sourceDescriptor,
    validateTransferStart
} from "./ArtifactSource.js";
import {
    ARTIFACT_RECORD_VERSION,
    DEFAULT_ARTIFACT_CHUNK_BYTES,
    DEFAULT_ARTIFACT_SHARE_TTL_SECONDS,
    MAX_ARTIFACT_SHARE_TTL_SECONDS,
    type ArtifactServiceEndpoint,
    type ArtifactServiceOptions,
    type ArtifactShareAccess,
    type StoredArtifactShare,
    type StoredArtifactTransfer
} from "./ArtifactServiceTypes.js";
import { ArtifactTransferExecutor } from "./ArtifactTransferExecutor.js";

export type {
    ArtifactServiceEndpoint,
    ArtifactServiceOptions,
    ArtifactServiceSchedule,
    ArtifactShareAccess
} from "./ArtifactServiceTypes.js";

export class ArtifactService {
    readonly #recordStore: ArtifactRecordStore;
    readonly #resolveEndpoint: (instance: string) => ArtifactServiceEndpoint | undefined;
    readonly #shareUrl: (token: string) => string;
    readonly #shares = new Map<string, StoredArtifactShare>();
    readonly #shareIdsByToken = new Map<string, string>();
    readonly #transfers = new Map<string, StoredArtifactTransfer>();
    readonly #transferExecutor: ArtifactTransferExecutor;
    readonly #transferWaiters = new Map<string, Set<(record: ArtifactTransferRecord) => void>>();
    #generation = 0;
    #initialized = false;

    constructor(options: ArtifactServiceOptions) {
        const chunkBytes = options.chunkBytes ?? DEFAULT_ARTIFACT_CHUNK_BYTES;
        if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
            throw new TypeError("Artifact chunkBytes must be a positive integer.");
        }
        this.#recordStore = new ArtifactRecordStore(options.storageDir);
        this.#resolveEndpoint = options.resolveEndpoint;
        this.#shareUrl = options.shareUrl;
        this.#transferExecutor = new ArtifactTransferExecutor({
            chunkBytes,
            emitTransferEvent: async (transfer, type) => await this.#emitTransferEvent(transfer, type),
            getTransfer: (transferId) => this.#transfers.get(transferId),
            isRunActive: (generation) => this.#initialized && this.#generation === generation,
            onTerminal: (record) => this.#resolveTransferWaiters(record),
            persistTransfer: async (transfer) => await this.#recordStore.persistTransfer(transfer),
            resolveEndpoint: options.resolveEndpoint,
            schedule: options.schedule ?? ((task) => queueMicrotask(task))
        });
    }

    async initialize(): Promise<void> {
        this.#generation += 1;
        await this.#recordStore.initialize();
        this.#shares.clear();
        this.#shareIdsByToken.clear();
        this.#transfers.clear();
        for (const share of await this.#recordStore.loadShares()) {
            this.#shares.set(share.result.shareId, share);
            this.#shareIdsByToken.set(share.token, share.result.shareId);
        }
        for (const transfer of await this.#recordStore.loadTransfers()) {
            this.#transfers.set(transfer.record.transferId, transfer);
        }
        this.#initialized = true;

        const now = Date.now();
        for (const share of this.#shares.values()) {
            if (share.result.state === "active" && share.result.expiresAtMs <= now) {
                await this.#expireShare(share);
            } else if (share.result.state !== "active" && !share.payloadClosed) {
                await this.#closeSharePayload(share);
            }
        }

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
            await this.#emitTransferEvent(transfer, "artifact.transferInterrupted");
            this.#resolveTransferWaiters(transfer.record);
        }
    }

    async stop(): Promise<void> {
        if (!this.#initialized) {
            return;
        }
        this.#initialized = false;
        this.#generation += 1;
        for (const transfer of this.#transfers.values()) {
            if (transfer.record.status === "queued" || isArtifactTransferTerminal(transfer.record.status)) {
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
            await this.#emitTransferEvent(transfer, "artifact.transferInterrupted");
            this.#resolveTransferWaiters(transfer.record);
        }
    }

    async createShare(input: ArtifactShareInput, defaultInstance: string): Promise<ArtifactShareResult> {
        this.#assertInitialized();
        const sourceInstance = readSourceInstance(input.instance, defaultInstance);
        const endpoint = this.#requireEndpoint(sourceInstance);
        const expiresInSeconds = input.expiresInSeconds ?? DEFAULT_ARTIFACT_SHARE_TTL_SECONDS;
        if (
            !Number.isInteger(expiresInSeconds) ||
            expiresInSeconds < 60 ||
            expiresInSeconds > MAX_ARTIFACT_SHARE_TTL_SECONDS
        ) {
            throw createError({
                code: errorCodes.targetInvalid,
                message: `expiresInSeconds must be between 60 and ${MAX_ARTIFACT_SHARE_TTL_SECONDS}.`,
                retryable: false
            });
        }
        const sourceInput = readSharePayloadSourceInput(input);
        const expiresAtMs = Date.now() + expiresInSeconds * 1000;
        const opened = await endpoint.openArtifactPayload({ ...sourceInput, expiresAtMs });
        const shareId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const result: ArtifactShareResult = {
            blake3: opened.descriptor.payloadBlake3,
            bytes: opened.descriptor.payloadBytes,
            downloadName: opened.descriptor.name,
            expiresAtMs,
            mediaType: opened.descriptor.mediaType,
            shareId,
            source: sourceDescriptor(sourceInstance, sourceInput, opened.descriptor),
            state: "active",
            url: this.#shareUrl(token)
        };
        const stored: StoredArtifactShare = {
            payloadClosed: false,
            payloadId: opened.payloadId,
            result,
            sourceInstance,
            token,
            version: ARTIFACT_RECORD_VERSION
        };
        try {
            await this.#recordStore.persistShare(stored);
        } catch (error) {
            await endpoint.closeArtifactPayload(opened.payloadId).catch(() => undefined);
            throw error;
        }
        this.#shares.set(shareId, stored);
        this.#shareIdsByToken.set(token, shareId);
        await this.#emitToEndpoint(endpoint, "artifact.shareCreated", result);
        return cloneShareResult(result);
    }

    listShares(): ArtifactShareResult[] {
        this.#assertInitialized();
        return [...this.#shares.values()]
            .map((share) => cloneShareResult(share.result))
            .sort((left, right) => right.expiresAtMs - left.expiresAtMs);
    }

    async revokeShare(shareId: string): Promise<ArtifactShareRevokeResult> {
        this.#assertInitialized();
        const share = this.#shares.get(shareId);
        if (share === undefined) {
            throw createError({
                code: errorCodes.artifactShareNotFound,
                message: "Artifact share was not found.",
                retryable: false,
                details: { shareId }
            });
        }
        if (share.result.state !== "revoked") {
            share.result.state = "revoked";
            await this.#recordStore.persistShare(share);
            await this.#closeSharePayload(share);
            const endpoint = this.#resolveEndpoint(share.sourceInstance);
            if (endpoint !== undefined) {
                await this.#emitToEndpoint(endpoint, "artifact.shareRevoked", share.result);
            }
        }
        return { revoked: true, shareId };
    }

    async resolveShare(token: string): Promise<ArtifactShareAccess> {
        this.#assertInitialized();
        const shareId = this.#shareIdsByToken.get(token);
        const share = shareId === undefined ? undefined : this.#shares.get(shareId);
        if (share === undefined) {
            throw createError({
                code: errorCodes.artifactShareNotFound,
                message: "Artifact share was not found.",
                retryable: false
            });
        }
        if (share.result.state === "revoked") {
            throw createError({
                code: errorCodes.artifactShareRevoked,
                message: "Artifact share has been revoked.",
                retryable: false,
                details: { shareId: share.result.shareId }
            });
        }
        if (share.result.state === "expired" || share.result.expiresAtMs <= Date.now()) {
            await this.#expireShare(share);
            throw createError({
                code: errorCodes.artifactShareExpired,
                message: "Artifact share has expired.",
                retryable: false,
                details: { shareId: share.result.shareId }
            });
        }
        return {
            payloadId: share.payloadId,
            share: cloneShareResult(share.result),
            sourceInstance: share.sourceInstance
        };
    }

    async readSharePayload(
        token: string,
        offsetBytes: number,
        maxBytes: number
    ): Promise<WorkerArtifactPayloadReadResult> {
        const access = await this.resolveShare(token);
        const endpoint = this.#requireEndpoint(access.sourceInstance);
        return await endpoint.readArtifactPayload({
            maxBytes,
            offsetBytes,
            payloadId: access.payloadId
        });
    }

    async recordShareDownloaded(token: string, details?: JsonValue): Promise<void> {
        const access = await this.resolveShare(token);
        const endpoint = this.#resolveEndpoint(access.sourceInstance);
        if (endpoint !== undefined) {
            await this.#emitToEndpoint(endpoint, "artifact.shareDownloaded", {
                ...(isJsonRecord(details) ? details : {}),
                shareId: access.share.shareId
            });
        }
    }

    async startTransfer(
        input: ArtifactTransferStartInput,
        defaultInstance: string
    ): Promise<ArtifactTransferResult> {
        this.#assertInitialized();
        validateTransferStart(input);
        const sourceInstance = readSourceInstance(input.instance, defaultInstance);
        this.#requireEndpoint(sourceInstance);
        this.#requireEndpoint(input.targetInstance);
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
        return { operation: "start", transfer: cloneTransferRecord(record) };
    }

    getTransfer(transferId: string): ArtifactTransferRecord {
        this.#assertInitialized();
        const transfer = this.#transfers.get(transferId);
        if (transfer === undefined) {
            throw transferNotFound(transferId);
        }
        return cloneTransferRecord(transfer.record);
    }

    listTransfers(): ArtifactTransferRecord[] {
        this.#assertInitialized();
        return [...this.#transfers.values()]
            .map((transfer) => cloneTransferRecord(transfer.record))
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }

    async lookupTransfer(input: ArtifactTransferLookupInput): Promise<ArtifactTransferResult> {
        return { operation: "status", transfer: this.getTransfer(input.transferId) };
    }

    async cancelTransfer(input: ArtifactTransferCancelInput | string): Promise<ArtifactTransferResult> {
        this.#assertInitialized();
        const transferId = typeof input === "string" ? input : input.transferId;
        const transfer = this.#transfers.get(transferId);
        if (transfer === undefined) {
            throw transferNotFound(transferId);
        }
        if (isArtifactTransferTerminal(transfer.record.status)) {
            return { operation: "cancel", transfer: cloneTransferRecord(transfer.record) };
        }
        transfer.cancelRequested = true;
        const now = new Date().toISOString();
        if (transfer.record.status === "queued") {
            transfer.record.status = "cancelled";
            transfer.record.completedAt = now;
            transfer.record.updatedAt = now;
            await this.#recordStore.persistTransfer(transfer);
            await this.#emitTransferEvent(transfer, "artifact.transferCancelled");
            this.#resolveTransferWaiters(transfer.record);
        } else {
            transfer.record.status = "cancelling";
            transfer.record.updatedAt = now;
            await this.#recordStore.persistTransfer(transfer);
        }
        return { operation: "cancel", transfer: cloneTransferRecord(transfer.record) };
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

    async #emitTransferEvent(transfer: StoredArtifactTransfer, type: ArtifactEventType): Promise<void> {
        const sourceEndpoint = this.#resolveEndpoint(transfer.record.source.instance);
        const targetEndpoint = this.#resolveEndpoint(transfer.record.target.instance);
        const data = toJsonValue(transfer.record);
        if (sourceEndpoint !== undefined) {
            await this.#emitToEndpoint(sourceEndpoint, type, data);
        }
        if (targetEndpoint !== undefined && targetEndpoint !== sourceEndpoint) {
            await this.#emitToEndpoint(targetEndpoint, type, data);
        }
    }

    async #emitToEndpoint(
        endpoint: ArtifactServiceEndpoint,
        type: ArtifactEventType,
        data?: unknown
    ): Promise<void> {
        await endpoint.appendControlEvent(type, data === undefined ? undefined : toJsonValue(data)).catch(() => undefined);
    }

    async #expireShare(share: StoredArtifactShare): Promise<void> {
        if (share.result.state !== "expired") {
            share.result.state = "expired";
            await this.#recordStore.persistShare(share);
        }
        await this.#closeSharePayload(share);
        const endpoint = this.#resolveEndpoint(share.sourceInstance);
        if (endpoint !== undefined) {
            await this.#emitToEndpoint(endpoint, "artifact.shareExpired", share.result);
        }
    }

    async #closeSharePayload(share: StoredArtifactShare): Promise<void> {
        if (share.payloadClosed) {
            return;
        }
        const endpoint = this.#resolveEndpoint(share.sourceInstance);
        if (endpoint === undefined) {
            return;
        }
        try {
            await endpoint.closeArtifactPayload(share.payloadId);
            share.payloadClosed = true;
            await this.#recordStore.persistShare(share);
        } catch {
            // Keep payloadClosed false so a later initialize/revoke can retry.
        }
    }

    #requireEndpoint(instance: string): ArtifactServiceEndpoint {
        const endpoint = this.#resolveEndpoint(instance);
        if (endpoint !== undefined) {
            return endpoint;
        }
        throw createError({
            code: errorCodes.instanceMissing,
            message: `Instance ${instance} was not found.`,
            retryable: false,
            details: { instance }
        });
    }

    #assertInitialized(): void {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
    }

    #resolveTransferWaiters(record: ArtifactTransferRecord): void {
        const waiters = this.#transferWaiters.get(record.transferId);
        if (waiters === undefined) {
            return;
        }
        this.#transferWaiters.delete(record.transferId);
        const cloned = cloneTransferRecord(record);
        for (const resolve of waiters) {
            resolve(cloned);
        }
    }
}

function transferNotFound(transferId: string) {
    return createError({
        code: errorCodes.artifactTransferNotFound,
        message: "Artifact transfer was not found.",
        retryable: false,
        details: { transferId }
    });
}

function cloneShareResult(result: ArtifactShareResult): ArtifactShareResult {
    return structuredClone(result);
}

function cloneTransferRecord(record: ArtifactTransferRecord): ArtifactTransferRecord {
    return structuredClone(record);
}

function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}