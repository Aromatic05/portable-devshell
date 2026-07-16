import type { WorkerArtifactPayloadReadResult } from "@portable-devshell/core";
import {
    createError,
    errorCodes,
    toControlErrorBody,
    type ArtifactEventType,
    type ArtifactTransferFailure,
    type ArtifactTransferRecord
} from "@portable-devshell/shared";

import { readTransferPayloadSourceInput, sourceTypeFromPayload } from "../ArtifactSource.js";
import {
    ARTIFACT_TRANSFER_PAYLOAD_TTL_MS,
    requireArtifactEndpoint,
    type ArtifactServiceEndpoint,
    type ArtifactServiceSchedule,
    type StoredArtifactTransfer
} from "../ArtifactServiceModel.js";

interface ArtifactTransferExecutorOptions {
    chunkBytes: number;
    emitTransferEvent: (transfer: StoredArtifactTransfer, type: ArtifactEventType) => Promise<void>;
    getTransfer: (transferId: string) => StoredArtifactTransfer | undefined;
    isRunActive: (generation: number) => boolean;
    onTerminal: (record: ArtifactTransferRecord) => void;
    persistTransfer: (transfer: StoredArtifactTransfer) => Promise<void>;
    resolveEndpoint: (instance: string, authorityInstance?: string) => ArtifactServiceEndpoint | undefined;
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
    readonly #emitTransferEvent: ArtifactTransferExecutorOptions["emitTransferEvent"];
    readonly #getTransfer: ArtifactTransferExecutorOptions["getTransfer"];
    readonly #isRunActive: ArtifactTransferExecutorOptions["isRunActive"];
    readonly #onTerminal: ArtifactTransferExecutorOptions["onTerminal"];
    readonly #persistTransfer: ArtifactTransferExecutorOptions["persistTransfer"];
    readonly #resolveEndpoint: ArtifactTransferExecutorOptions["resolveEndpoint"];
    readonly #schedule: ArtifactServiceSchedule;
    readonly #runningTransfers = new Set<string>();

    constructor(options: ArtifactTransferExecutorOptions) {
        this.#chunkBytes = options.chunkBytes;
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
            void this.#run(transferId, generation);
        });
    }

    async cleanupResources(transfer: StoredArtifactTransfer): Promise<void> {
        const sourceEndpoint = this.#resolveEndpoint(transfer.record.source.instance, transfer.defaultInstance);
        const targetEndpoint = this.#resolveEndpoint(transfer.record.target.instance, transfer.defaultInstance);
        if (transfer.receiveId !== undefined && targetEndpoint !== undefined) {
            await targetEndpoint.abortArtifactReceive(transfer.receiveId).catch(() => undefined);
            transfer.receiveId = undefined;
        }
        await this.#closePayload(transfer, sourceEndpoint);
        await this.#persistTransfer(transfer);
    }

    async #run(transferId: string, generation: number): Promise<void> {
        if (!this.#isRunActive(generation) || this.#runningTransfers.has(transferId)) {
            return;
        }
        const transfer = this.#getTransfer(transferId);
        if (transfer === undefined || transfer.record.status !== "queued") {
            return;
        }
        this.#runningTransfers.add(transferId);
        let sourceEndpoint: ArtifactServiceEndpoint | undefined;
        let targetEndpoint: ArtifactServiceEndpoint | undefined;
        try {
            this.#throwIfCancelled(transfer);
            sourceEndpoint = requireArtifactEndpoint(this.#resolveEndpoint, transfer.record.source.instance, transfer.defaultInstance);
            targetEndpoint = requireArtifactEndpoint(this.#resolveEndpoint, transfer.record.target.instance, transfer.defaultInstance);
            const startedAt = new Date().toISOString();
            transfer.record.status = "preparing";
            transfer.record.startedAt = startedAt;
            transfer.record.updatedAt = startedAt;
            await this.#persistTransfer(transfer);
            this.#assertRunActive(generation);
            await this.#emitTransferEvent(transfer, "artifact.transferStarted");

            const sourceInput = readTransferPayloadSourceInput(transfer.request);
            const opened = await sourceEndpoint.openArtifactPayload({
                ...sourceInput,
                expiresAtMs: Date.now() + ARTIFACT_TRANSFER_PAYLOAD_TTL_MS
            });
            transfer.payloadId = opened.payloadId;
            this.#assertRunActive(generation);
            transfer.record.payload = opened.descriptor;
            transfer.record.totalBytes = opened.descriptor.payloadBytes;
            transfer.record.source.type = sourceTypeFromPayload(opened.descriptor);
            transfer.record.updatedAt = new Date().toISOString();
            await this.#persistTransfer(transfer);
            this.#assertRunActive(generation);
            this.#throwIfCancelled(transfer);

            const receive = await targetEndpoint.beginArtifactReceive({
                descriptor: opened.descriptor,
                overwrite: transfer.request.overwrite ?? false,
                targetPath: transfer.request.targetPath
            });
            transfer.receiveId = receive.receiveId;
            this.#assertRunActive(generation);
            transfer.record.status = "transferring";
            transfer.record.updatedAt = new Date().toISOString();
            await this.#persistTransfer(transfer);
            this.#assertRunActive(generation);

            let offsetBytes = receive.nextOffsetBytes;
            while (offsetBytes < opened.descriptor.payloadBytes) {
                this.#throwIfCancelled(transfer);
                const chunk = await sourceEndpoint.readArtifactPayload({
                    maxBytes: Math.min(this.#chunkBytes, opened.descriptor.payloadBytes - offsetBytes),
                    offsetBytes,
                    payloadId: opened.payloadId
                });
                this.#assertRunActive(generation);
                validatePayloadChunk(chunk, offsetBytes, opened.descriptor.payloadBytes);
                const written = await targetEndpoint.writeArtifactReceive({
                    content: chunk.content,
                    offsetBytes,
                    receiveId: receive.receiveId
                });
                this.#assertRunActive(generation);
                if (written.nextOffsetBytes !== offsetBytes + chunk.returnedBytes) {
                    throw createError({
                        code: errorCodes.artifactPayloadInvalid,
                        message: "Artifact receiver returned an unexpected offset.",
                        retryable: true,
                        details: {
                            actual: written.nextOffsetBytes,
                            expected: offsetBytes + chunk.returnedBytes,
                            transferId
                        }
                    });
                }
                offsetBytes = written.nextOffsetBytes;
                transfer.record.transferredBytes = offsetBytes;
                transfer.record.updatedAt = new Date().toISOString();
                await this.#persistTransfer(transfer);
                this.#assertRunActive(generation);
                await this.#emitTransferEvent(transfer, "artifact.transferProgress");
            }

            this.#throwIfCancelled(transfer);
            transfer.record.status = "verifying";
            transfer.record.updatedAt = new Date().toISOString();
            await this.#persistTransfer(transfer);
            transfer.record.status = "committing";
            transfer.record.updatedAt = new Date().toISOString();
            await this.#persistTransfer(transfer);
            const finished = await targetEndpoint.finishArtifactReceive(receive.receiveId);
            this.#assertRunActive(generation);
            if (
                finished.bytes !== opened.descriptor.payloadBytes ||
                finished.blake3 !== opened.descriptor.payloadBlake3
            ) {
                throw createError({
                    code: errorCodes.artifactPayloadInvalid,
                    message: "Artifact receiver verification result does not match the source payload.",
                    retryable: false,
                    details: { transferId }
                });
            }
            await this.#closePayload(transfer, sourceEndpoint);
            this.#assertRunActive(generation);

            transfer.receiveId = undefined;
            transfer.record.status = "completed";
            transfer.record.completedAt = new Date().toISOString();
            transfer.record.updatedAt = transfer.record.completedAt;
            transfer.record.transferredBytes = opened.descriptor.payloadBytes;
            await this.#persistTransfer(transfer);
            await this.#emitTransferEvent(transfer, "artifact.transferCompleted");
            this.#onTerminal(transfer.record);
        } catch (error) {
            if (!this.#isRunActive(generation) || error instanceof ArtifactServiceStoppedError) {
                await this.cleanupResources(transfer);
                return;
            }
            await this.#handleFailure(transfer, error, sourceEndpoint, targetEndpoint);
        } finally {
            await this.#closePayload(transfer, sourceEndpoint);
            this.#runningTransfers.delete(transferId);
        }
    }

    async #handleFailure(
        transfer: StoredArtifactTransfer,
        error: unknown,
        sourceEndpoint?: ArtifactServiceEndpoint,
        targetEndpoint?: ArtifactServiceEndpoint
    ): Promise<void> {
        if (transfer.receiveId !== undefined && targetEndpoint !== undefined) {
            await targetEndpoint.abortArtifactReceive(transfer.receiveId).catch(() => undefined);
            transfer.receiveId = undefined;
        }
        const now = new Date().toISOString();
        if (error instanceof ArtifactTransferCancelledError || transfer.cancelRequested) {
            transfer.record.status = "cancelled";
            transfer.record.completedAt = now;
            transfer.record.updatedAt = now;
            transfer.record.failure = undefined;
            await this.#persistTransfer(transfer);
            await this.#emitTransferEvent(transfer, "artifact.transferCancelled");
        } else {
            transfer.record.status = "failed";
            transfer.record.completedAt = now;
            transfer.record.updatedAt = now;
            transfer.record.failure = failureFromError(error);
            await this.#persistTransfer(transfer);
            await this.#emitTransferEvent(transfer, "artifact.transferFailed");
        }
        await this.#closePayload(transfer, sourceEndpoint);
        this.#onTerminal(transfer.record);
    }

    async #closePayload(
        transfer: StoredArtifactTransfer,
        sourceEndpoint = this.#resolveEndpoint(transfer.record.source.instance)
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
        if (transfer.cancelRequested || transfer.record.status === "cancelling") {
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
    totalBytes: number
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
            retryable: true
        });
    }
}

function failureFromError(error: unknown): ArtifactTransferFailure {
    const body = toControlErrorBody(error);
    if (body !== undefined) {
        return {
            code: body.code,
            message: body.message,
            retryable: body.retryable
        };
    }
    return {
        code: errorCodes.coreProviderFailed,
        message: error instanceof Error ? error.message : String(error),
        retryable: true
    };
}
