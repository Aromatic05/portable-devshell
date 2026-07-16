import { randomBytes, randomUUID } from "node:crypto";

import type { WorkerArtifactPayloadReadResult } from "@portable-devshell/core";
import {
    createError,
    errorCodes,
    type ArtifactEventType,
    type ArtifactShareInput,
    type ArtifactShareResult,
    type ArtifactShareRevokeResult,
    type JsonValue
} from "@portable-devshell/shared";

import { ArtifactRecordStore } from "../ArtifactRecordStore.js";
import {
    readSharePayloadSourceInput,
    readSourceInstance,
    sourceDescriptor
} from "../ArtifactSource.js";
import {
    ARTIFACT_RECORD_VERSION,
    DEFAULT_ARTIFACT_SHARE_TTL_SECONDS,
    MAX_ARTIFACT_SHARE_TTL_SECONDS,
    requireArtifactEndpoint,
    type ArtifactServiceEndpoint,
    type ArtifactServiceOptions,
    type ArtifactShareAccess,
    type StoredArtifactShare
} from "../ArtifactServiceModel.js";

export interface ArtifactShareServiceOptions {
    recordStore: ArtifactRecordStore;
    resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    shareUrl: ArtifactServiceOptions["shareUrl"];
}

export class ArtifactShareService {
    readonly #recordStore: ArtifactRecordStore;
    readonly #resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    readonly #shareUrl: ArtifactServiceOptions["shareUrl"];
    readonly #shares = new Map<string, StoredArtifactShare>();
    readonly #shareIdsByToken = new Map<string, string>();
    #initialized = false;

    constructor(options: ArtifactShareServiceOptions) {
        this.#recordStore = options.recordStore;
        this.#resolveEndpoint = options.resolveEndpoint;
        this.#shareUrl = options.shareUrl;
    }

    async initialize(): Promise<void> {
        this.#shares.clear();
        this.#shareIdsByToken.clear();

        for (const share of await this.#recordStore.loadShares()) {
            share.authorityInstance ??= share.sourceInstance;
            this.#shares.set(share.result.shareId, share);
            this.#shareIdsByToken.set(share.token, share.result.shareId);
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
    }

    stop(): void {
        this.#initialized = false;
    }

    async createShare(
        input: ArtifactShareInput,
        defaultInstance: string
    ): Promise<ArtifactShareResult> {
        this.#assertInitialized();
        const sourceInstance = readSourceInstance(input.instance, defaultInstance);
        const endpoint = requireArtifactEndpoint(
            this.#resolveEndpoint,
            sourceInstance,
            defaultInstance
        );
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
        const opened = await endpoint.openArtifactPayload({
            ...sourceInput,
            expiresAtMs
        });
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
            authorityInstance: defaultInstance,
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
        return structuredClone(result);
    }

    listShares(): ArtifactShareResult[] {
        this.#assertInitialized();
        return [...this.#shares.values()]
            .map((share) => structuredClone(share.result))
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
            const endpoint = this.#resolveEndpoint(
                share.sourceInstance,
                share.authorityInstance
            );
            if (endpoint !== undefined) {
                await this.#emitToEndpoint(
                    endpoint,
                    "artifact.shareRevoked",
                    share.result
                );
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
            share: structuredClone(share.result),
            sourceInstance: share.sourceInstance
        };
    }

    async readSharePayload(
        token: string,
        offsetBytes: number,
        maxBytes: number
    ): Promise<WorkerArtifactPayloadReadResult> {
        const access = await this.resolveShare(token);
        const share = this.#shares.get(access.share.shareId);
        const endpoint = requireArtifactEndpoint(
            this.#resolveEndpoint,
            access.sourceInstance,
            share?.authorityInstance ?? access.sourceInstance
        );
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

    async #expireShare(share: StoredArtifactShare): Promise<void> {
        if (share.result.state !== "expired") {
            share.result.state = "expired";
            await this.#recordStore.persistShare(share);
        }
        await this.#closeSharePayload(share);
        const endpoint = this.#resolveEndpoint(
            share.sourceInstance,
            share.authorityInstance
        );
        if (endpoint !== undefined) {
            await this.#emitToEndpoint(
                endpoint,
                "artifact.shareExpired",
                share.result
            );
        }
    }

    async #closeSharePayload(share: StoredArtifactShare): Promise<void> {
        if (share.payloadClosed) return;
        const endpoint = this.#resolveEndpoint(
            share.sourceInstance,
            share.authorityInstance
        );
        if (endpoint === undefined) return;

        try {
            await endpoint.closeArtifactPayload(share.payloadId);
            share.payloadClosed = true;
            await this.#recordStore.persistShare(share);
        } catch {
            // Keep payloadClosed false so a later initialize or revoke can retry.
        }
    }

    async #emitToEndpoint(
        endpoint: ArtifactServiceEndpoint,
        type: ArtifactEventType,
        data?: unknown
    ): Promise<void> {
        await endpoint.appendControlEvent(
            type,
            data === undefined ? undefined : toJsonValue(data)
        ).catch(() => undefined);
    }

    #assertInitialized(): void {
        if (!this.#initialized) {
            throw new Error("ArtifactService is not initialized.");
        }
    }
}

function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
