import { randomBytes, randomUUID } from "node:crypto";

import type { WorkerArtifactPayloadReadResult } from "@portable-devshell/core/instance";
import {
    createRemoteError,
    artifactErrorCodes,
    type ArtifactEventType,
    type ArtifactShareInput,
    type ArtifactShareResult,
    type ArtifactShareRevokeResult,
    type JsonValue,
    controlErrorCodes,
} from "@portable-devshell/shared";

import { ArtifactRecordStore } from "../RecordStore.js";
import {
    readSharePayloadSourceInput,
    readSourceInstance,
    sourceDescriptor,
} from "../Source.js";
import {
    ARTIFACT_RECORD_VERSION,
    DEFAULT_ARTIFACT_SHARE_TTL_SECONDS,
    MAX_ARTIFACT_SHARE_TTL_SECONDS,
    requireArtifactEndpoint,
    type ArtifactEventRecorder,
    type ArtifactServiceEndpoint,
    type ArtifactServiceOptions,
    type StoredArtifactShare,
} from "../Service.js";
import type { ArtifactShareAccess } from "../Api.js";

export interface ArtifactShareServiceOptions {
    recordEvent: ArtifactEventRecorder;
    recordStore: ArtifactRecordStore;
    resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    shareUrl: ArtifactServiceOptions["shareUrl"];
    terminalHistoryLimit: number;
}

export class ArtifactShareService {
    readonly #activeDownloads = new Map<string, number>();
    readonly #recordEvent: ArtifactEventRecorder;
    readonly #recordStore: ArtifactRecordStore;
    readonly #resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    readonly #shareUrl: ArtifactServiceOptions["shareUrl"];
    readonly #terminalHistoryLimit: number;
    readonly #shares = new Map<string, StoredArtifactShare>();
    readonly #shareIdsByToken = new Map<string, string>();
    #initialized = false;
    #lastTerminalAtMs = 0;

    constructor(options: ArtifactShareServiceOptions) {
        this.#recordEvent = options.recordEvent;
        this.#recordStore = options.recordStore;
        this.#resolveEndpoint = options.resolveEndpoint;
        this.#shareUrl = options.shareUrl;
        this.#terminalHistoryLimit = options.terminalHistoryLimit;
    }

    async initialize(): Promise<void> {
        this.#activeDownloads.clear();
        this.#shares.clear();
        this.#shareIdsByToken.clear();

        for (const share of await this.#recordStore.loadShares()) {
            share.authorityInstance ??= share.sourceInstance;
            share.result.downloadCount ??= 0;
            this.#shares.set(share.result.shareId, share);
            this.#shareIdsByToken.set(share.token, share.result.shareId);
            this.#lastTerminalAtMs = Math.max(
                this.#lastTerminalAtMs,
                share.terminalAtMs ?? 0,
            );
        }

        this.#initialized = true;
        const now = Date.now();
        for (const share of this.#shares.values()) {
            if (
                share.result.state === "active" &&
                share.result.maxDownloads !== undefined &&
                (share.result.downloadCount ?? 0) >= share.result.maxDownloads
            ) {
                await this.#exhaustShare(share);
            } else if (
                share.result.state === "active" &&
                share.result.expiresAtMs <= now
            ) {
                await this.#expireShare(share);
            } else if (
                share.result.state !== "active" &&
                !share.payloadClosed
            ) {
                await this.#closeSharePayload(share);
            }
        }
        await this.#compactTerminalHistory();
    }

    stop(): void {
        this.#initialized = false;
        this.#activeDownloads.clear();
    }

    async createShare(
        input: ArtifactShareInput,
        defaultInstance: string,
    ): Promise<ArtifactShareResult> {
        this.#assertInitialized();
        const sourceInstance = readSourceInstance(
            input.instance,
            defaultInstance,
        );
        const endpoint = requireArtifactEndpoint(
            this.#resolveEndpoint,
            sourceInstance,
            defaultInstance,
        );
        const expiresInSeconds =
            input.expiresInSeconds ?? DEFAULT_ARTIFACT_SHARE_TTL_SECONDS;
        if (
            input.maxDownloads !== undefined &&
            (!Number.isSafeInteger(input.maxDownloads) ||
                input.maxDownloads < 1)
        ) {
            throw createRemoteError({
                code: controlErrorCodes.invalidTarget,
                message: "maxDownloads must be a positive safe integer.",
                retryable: false,
            });
        }

        if (
            !Number.isInteger(expiresInSeconds) ||
            expiresInSeconds < 60 ||
            expiresInSeconds > MAX_ARTIFACT_SHARE_TTL_SECONDS
        ) {
            throw createRemoteError({
                code: controlErrorCodes.invalidTarget,
                message: `expiresInSeconds must be between 60 and ${MAX_ARTIFACT_SHARE_TTL_SECONDS}.`,
                retryable: false,
            });
        }

        const sourceInput = readSharePayloadSourceInput(input);
        const expiresAtMs = Date.now() + expiresInSeconds * 1000;
        const opened = await endpoint.openArtifactPayload({
            ...sourceInput,
            expiresAtMs,
        });
        const shareId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const result: ArtifactShareResult = {
            blake3: opened.descriptor.payloadBlake3,
            bytes: opened.descriptor.payloadBytes,
            downloadCount: 0,
            downloadName: opened.descriptor.name,
            expiresAtMs,
            ...(input.maxDownloads === undefined
                ? {}
                : { maxDownloads: input.maxDownloads }),
            mediaType: opened.descriptor.mediaType,
            shareId,
            source: sourceDescriptor(
                sourceInstance,
                sourceInput,
                opened.descriptor,
            ),
            state: "active",
            url: this.#shareUrl(token),
        };
        const stored: StoredArtifactShare = {
            authorityInstance: defaultInstance,
            payloadClosed: false,
            payloadId: opened.payloadId,
            result,
            sourceInstance,
            token,
            version: ARTIFACT_RECORD_VERSION,
        };

        try {
            await this.#recordStore.persistShare(stored);
        } catch (error) {
            await endpoint
                .closeArtifactPayload(opened.payloadId)
                .catch(() => undefined);
            throw error;
        }

        this.#shares.set(shareId, stored);
        this.#shareIdsByToken.set(token, shareId);
        this.#record("artifact.shareCreated", stored.authorityInstance, result);
        return structuredClone(result);
    }

    listShares(): ArtifactShareResult[] {
        this.#assertInitialized();
        return [...this.#shares.values()]
            .map((share) => structuredClone(share.result))
            .sort((left, right) => right.expiresAtMs - left.expiresAtMs);
    }

    async retireInstance(instance: string): Promise<void> {
        this.#assertInitialized();
        const shareIds = [...this.#shares.values()]
            .filter(
                (share) =>
                    share.result.state === "active" &&
                    (share.sourceInstance === instance ||
                        share.authorityInstance === instance),
            )
            .map((share) => share.result.shareId);
        for (const shareId of shareIds) {
            await this.revokeShare(shareId);
        }
    }

    async revokeShare(shareId: string): Promise<ArtifactShareRevokeResult> {
        this.#assertInitialized();
        const share = this.#shares.get(shareId);
        if (share === undefined) {
            throw createRemoteError({
                code: artifactErrorCodes.shareNotFound,
                message: "Artifact share was not found.",
                retryable: false,
                details: { shareId },
            });
        }

        if (share.result.state !== "revoked") {
            const previousState = share.result.state;
            const previousTerminalAtMs = share.terminalAtMs;
            share.result.state = "revoked";
            share.terminalAtMs = this.#nextTerminalAtMs();
            try {
                await this.#recordStore.persistShare(share);
            } catch (error) {
                share.result.state = previousState;
                share.terminalAtMs = previousTerminalAtMs;
                throw error;
            }
            await this.#closeSharePayload(share);
            this.#record(
                "artifact.shareRevoked",
                share.authorityInstance,
                share.result,
            );
            await this.#compactTerminalHistory();
        }

        return { revoked: true, shareId };
    }

    async resolveShare(token: string): Promise<ArtifactShareAccess> {
        this.#assertInitialized();
        const shareId = this.#shareIdsByToken.get(token);
        const share =
            shareId === undefined ? undefined : this.#shares.get(shareId);

        if (share === undefined) {
            throw createRemoteError({
                code: artifactErrorCodes.shareNotFound,
                message: "Artifact share was not found.",
                retryable: false,
            });
        }
        if (share.result.state === "revoked") {
            throw createRemoteError({
                code: artifactErrorCodes.shareRevoked,
                message: "Artifact share has been revoked.",
                retryable: false,
                details: { shareId: share.result.shareId },
            });
        }
        if (share.result.state === "exhausted") {
            throw exhaustedShare(share.result.shareId);
        }
        if (
            share.result.state === "expired" ||
            share.result.expiresAtMs <= Date.now()
        ) {
            await this.#expireShare(share);
            throw createRemoteError({
                code: artifactErrorCodes.shareExpired,
                message: "Artifact share has expired.",
                retryable: false,
                details: { shareId: share.result.shareId },
            });
        }

        return {
            payloadId: share.payloadId,
            share: structuredClone(share.result),
            sourceInstance: share.sourceInstance,
        };
    }

    async beginShareDownload(token: string): Promise<ArtifactShareAccess> {
        const access = await this.resolveShare(token);
        const shareId = access.share.shareId;
        const share = this.#shares.get(shareId)!;
        const active = this.#activeDownloads.get(shareId) ?? 0;
        if (
            share.result.maxDownloads !== undefined &&
            (share.result.downloadCount ?? 0) + active >=
                share.result.maxDownloads
        ) {
            throw exhaustedShare(shareId);
        }
        this.#activeDownloads.set(shareId, active + 1);
        return access;
    }

    async readSharePayload(
        access: ArtifactShareAccess,
        offsetBytes: number,
        maxBytes: number,
    ): Promise<WorkerArtifactPayloadReadResult> {
        const share = this.#shares.get(access.share.shareId);
        const endpoint = requireArtifactEndpoint(
            this.#resolveEndpoint,
            access.sourceInstance,
            share?.authorityInstance ?? access.sourceInstance,
        );
        return await endpoint.readArtifactPayload({
            maxBytes,
            offsetBytes,
            payloadId: access.payloadId,
        });
    }

    async finishShareDownload(
        token: string,
        completed: boolean,
        details?: JsonValue,
    ): Promise<void> {
        const shareId = this.#shareIdsByToken.get(token);
        const share =
            shareId === undefined ? undefined : this.#shares.get(shareId);
        if (share === undefined) return;
        if (!completed) {
            this.#releaseDownload(share.result.shareId);
            return;
        }

        await this.#commitDownload(share, details);
    }

    async #commitDownload(
        share: StoredArtifactShare,
        details?: JsonValue,
    ): Promise<void> {
        const shareId = share.result.shareId;
        const active = this.#activeDownloads.get(shareId) ?? 1;
        const remainingActive = Math.max(0, active - 1);
        const previousDownloadCount = share.result.downloadCount ?? 0;
        const previousState = share.result.state;
        const previousTerminalAtMs = share.terminalAtMs;
        share.result.downloadCount = (share.result.downloadCount ?? 0) + 1;
        const exhausted =
            share.result.maxDownloads !== undefined &&
            share.result.downloadCount >= share.result.maxDownloads &&
            remainingActive === 0;
        if (exhausted) {
            share.result.state = "exhausted";
            share.terminalAtMs = this.#nextTerminalAtMs();
        }
        this.#releaseDownload(shareId);
        try {
            await this.#recordStore.persistShare(share);
        } catch (error) {
            share.result.downloadCount = previousDownloadCount;
            share.result.state = previousState;
            share.terminalAtMs = previousTerminalAtMs;
            throw error;
        }

        const downloadData = {
            ...(isJsonRecord(details) ? details : {}),
            downloadCount: share.result.downloadCount,
            shareId,
        };
        this.#record(
            "artifact.shareDownloaded",
            share.authorityInstance,
            downloadData,
        );
        if (exhausted) {
            await this.#closeSharePayload(share);
            this.#record(
                "artifact.shareExhausted",
                share.authorityInstance,
                share.result,
            );
            await this.#compactTerminalHistory();
        }
    }

    #releaseDownload(shareId: string): void {
        const active = this.#activeDownloads.get(shareId) ?? 0;
        if (active <= 1) this.#activeDownloads.delete(shareId);
        else this.#activeDownloads.set(shareId, active - 1);
    }

    async #exhaustShare(share: StoredArtifactShare): Promise<void> {
        if (share.result.state !== "exhausted") {
            const previousState = share.result.state;
            const previousTerminalAtMs = share.terminalAtMs;
            share.result.state = "exhausted";
            share.terminalAtMs = this.#nextTerminalAtMs();
            try {
                await this.#recordStore.persistShare(share);
            } catch (error) {
                share.result.state = previousState;
                share.terminalAtMs = previousTerminalAtMs;
                throw error;
            }
        }
        await this.#closeSharePayload(share);
        this.#record(
            "artifact.shareExhausted",
            share.authorityInstance,
            share.result,
        );
        await this.#compactTerminalHistory();
    }

    async #expireShare(share: StoredArtifactShare): Promise<void> {
        if (share.result.state !== "expired") {
            const previousState = share.result.state;
            const previousTerminalAtMs = share.terminalAtMs;
            share.result.state = "expired";
            share.terminalAtMs = this.#nextTerminalAtMs();
            try {
                await this.#recordStore.persistShare(share);
            } catch (error) {
                share.result.state = previousState;
                share.terminalAtMs = previousTerminalAtMs;
                throw error;
            }
        }
        await this.#closeSharePayload(share);
        this.#record(
            "artifact.shareExpired",
            share.authorityInstance,
            share.result,
        );
        await this.#compactTerminalHistory();
    }

    async #compactTerminalHistory(): Promise<void> {
        const terminal = [...this.#shares.values()]
            .filter((share) => share.result.state !== "active")
            .sort((left, right) => {
                const byTime =
                    (left.terminalAtMs ?? left.result.expiresAtMs) -
                    (right.terminalAtMs ?? right.result.expiresAtMs);
                return byTime === 0
                    ? left.result.shareId.localeCompare(right.result.shareId)
                    : byTime;
            });
        while (terminal.length > this.#terminalHistoryLimit) {
            const share = terminal.shift()!;
            try {
                await this.#recordStore.deleteShare(share.result.shareId);
            } catch {
                return;
            }
            this.#shares.delete(share.result.shareId);
            this.#shareIdsByToken.delete(share.token);
        }
    }

    #nextTerminalAtMs(): number {
        this.#lastTerminalAtMs = Math.max(
            Date.now(),
            this.#lastTerminalAtMs + 1,
        );
        return this.#lastTerminalAtMs;
    }

    async #closeSharePayload(share: StoredArtifactShare): Promise<void> {
        if (share.payloadClosed) return;
        const endpoint = this.#resolveEndpoint(
            share.sourceInstance,
            share.authorityInstance,
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

    #record(type: ArtifactEventType, instance: string, data?: unknown): void {
        this.#recordEvent(
            instance,
            type,
            data === undefined ? undefined : toJsonValue(data),
        );
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

function isJsonRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exhaustedShare(shareId: string) {
    return createRemoteError({
        code: artifactErrorCodes.shareExhausted,
        message: "Artifact share has reached its download limit.",
        retryable: false,
        details: { shareId },
    });
}
