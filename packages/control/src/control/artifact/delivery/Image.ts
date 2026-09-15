import { createError, errorCodes } from "@portable-devshell/shared";
import type {
    ArtifactImageMediaType,
    ArtifactStoredImageResult,
    ArtifactViewImageInput,
    ArtifactViewImageResult,
} from "@portable-devshell/shared";
import {
    readImagePayloadSourceInput,
    readSourceInstance,
    sourceDescriptor,
} from "../Source.js";
import {
    DEFAULT_ARTIFACT_CHUNK_BYTES,
    requireArtifactEndpoint,
} from "../Service.js";
import type { ArtifactServiceOptions } from "../Service.js";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactBlake3 } from "../host/Hash.js";

export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;

const ARTIFACT_IMAGE_PAYLOAD_TTL_MS = 5 * 60 * 1000;

const MAX_ARTIFACT_IMAGE_CHUNK_BYTES = 1024 * 1024;

export class ArtifactImageService {
    readonly #chunkBytes: number;
    readonly #resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];
    readonly #store: ArtifactImageStore;

    constructor(
        options: Pick<
            ArtifactServiceOptions,
            "chunkBytes" | "resolveEndpoint" | "storageDir"
        >,
    ) {
        const requestedChunkBytes = options.chunkBytes;
        this.#chunkBytes =
            typeof requestedChunkBytes === "number" &&
            Number.isSafeInteger(requestedChunkBytes) &&
            requestedChunkBytes > 0
                ? Math.min(requestedChunkBytes, MAX_ARTIFACT_IMAGE_CHUNK_BYTES)
                : DEFAULT_ARTIFACT_CHUNK_BYTES;
        this.#resolveEndpoint = options.resolveEndpoint;
        this.#store = new ArtifactImageStore(options.storageDir);
    }

    async initialize(): Promise<void> {
        await this.#store.initialize();
    }

    async read(imageRef: string): Promise<ArtifactStoredImageResult> {
        return await this.#store.read(imageRef);
    }

    async view(
        input: ArtifactViewImageInput,
        defaultInstance: string,
        signal?: AbortSignal,
    ): Promise<ArtifactViewImageResult> {
        throwIfAborted(signal);
        const sourceInstance = readSourceInstance(
            input.instance,
            defaultInstance,
        );
        const endpoint = requireArtifactEndpoint(
            this.#resolveEndpoint,
            sourceInstance,
            defaultInstance,
        );
        const sourceInput = readImagePayloadSourceInput(input);
        const opened = await endpoint.openArtifactPayload({
            ...sourceInput,
            expiresAtMs: Date.now() + ARTIFACT_IMAGE_PAYLOAD_TTL_MS,
        });

        try {
            if (opened.descriptor.type === "directoryArchive") {
                throw unsupported(
                    "Artifact image source must be a file or byte artifact.",
                );
            }
            if (opened.descriptor.payloadBytes <= 0) {
                throw unsupported("Artifact image source is empty.");
            }
            if (opened.descriptor.payloadBytes > MAX_ARTIFACT_IMAGE_BYTES) {
                throw createError({
                    code: errorCodes.artifactImageTooLarge,
                    details: {
                        bytes: opened.descriptor.payloadBytes,
                        maxBytes: MAX_ARTIFACT_IMAGE_BYTES,
                    },
                    message: `Artifact image exceeds the ${MAX_ARTIFACT_IMAGE_BYTES}-byte limit.`,
                    retryable: false,
                });
            }

            const bytes = await this.#readPayload(
                endpoint,
                opened.payloadId,
                opened.descriptor.payloadBytes,
                signal,
            );
            const mediaType = detectArtifactImageMediaType(
                bytes.subarray(0, 16),
            );
            const stored = await this.#store.persist(bytes, mediaType);

            return {
                ...stored,
                name: opened.descriptor.name,
                source: sourceDescriptor(
                    sourceInstance,
                    sourceInput,
                    opened.descriptor,
                ),
            };
        } finally {
            await endpoint
                .closeArtifactPayload(opened.payloadId)
                .catch(() => undefined);
        }
    }

    async #readPayload(
        endpoint: ReturnType<typeof requireArtifactEndpoint>,
        payloadId: string,
        totalBytes: number,
        signal?: AbortSignal,
    ): Promise<Buffer> {
        const chunks: Buffer[] = [];
        let offsetBytes = 0;

        while (offsetBytes < totalBytes) {
            throwIfAborted(signal);
            const chunk = await endpoint.readArtifactPayload({
                maxBytes: Math.min(this.#chunkBytes, totalBytes - offsetBytes),
                offsetBytes,
                payloadId,
            });
            throwIfAborted(signal);
            validateChunk(chunk, payloadId, offsetBytes, totalBytes);
            const decoded = Buffer.from(chunk.content, "base64");
            if (decoded.length !== chunk.returnedBytes) {
                throw invalidPayload(
                    "Artifact image payload returned an invalid base64 chunk.",
                );
            }
            chunks.push(decoded);
            offsetBytes += decoded.length;
        }

        const result = Buffer.concat(chunks, totalBytes);
        if (result.length !== totalBytes) {
            throw invalidPayload(
                "Artifact image payload length changed during reading.",
            );
        }
        return result;
    }
}

export function detectArtifactImageMediaType(
    header: Uint8Array,
): ArtifactImageMediaType {
    const bytes = Buffer.from(header);
    if (
        bytes.length >= 8 &&
        bytes
            .subarray(0, 8)
            .equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            )
    ) {
        return "image/png";
    }
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    ) {
        return "image/jpeg";
    }
    if (bytes.length >= 6) {
        const gif = bytes.subarray(0, 6).toString("ascii");
        if (gif === "GIF87a" || gif === "GIF89a") {
            return "image/gif";
        }
    }
    if (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return "image/webp";
    }
    throw unsupported(
        "Unsupported artifact image format; expected PNG, JPEG, GIF, or WebP.",
    );
}

function validateChunk(
    chunk: {
        eof: boolean;
        nextOffsetBytes?: number;
        offsetBytes: number;
        payloadId: string;
        returnedBytes: number;
        totalBytes: number;
    },
    payloadId: string,
    expectedOffset: number,
    expectedTotal: number,
): void {
    if (
        chunk.payloadId !== payloadId ||
        chunk.offsetBytes !== expectedOffset ||
        chunk.totalBytes !== expectedTotal ||
        !Number.isSafeInteger(chunk.returnedBytes) ||
        chunk.returnedBytes <= 0 ||
        chunk.returnedBytes > expectedTotal - expectedOffset
    ) {
        throw invalidPayload(
            "Artifact image payload returned inconsistent chunk metadata.",
        );
    }
    const expectedNext = expectedOffset + chunk.returnedBytes;
    if (chunk.eof !== expectedNext >= expectedTotal) {
        throw invalidPayload(
            "Artifact image payload returned an inconsistent eof marker.",
        );
    }
    if (!chunk.eof && chunk.nextOffsetBytes !== expectedNext) {
        throw invalidPayload(
            "Artifact image payload returned an unexpected next offset.",
        );
    }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) {
        return;
    }
    throw createError({
        code: errorCodes.coreToolCallCancelled,
        cause: signal.reason,
        details: {
            reason:
                typeof signal.reason === "string"
                    ? signal.reason
                    : "client cancelled",
        },
        message: "Artifact image viewing was cancelled by the client.",
        retryable: true,
    });
}

function unsupported(message: string) {
    return createError({
        code: errorCodes.artifactImageUnsupported,
        message,
        retryable: false,
    });
}

function invalidPayload(message: string) {
    return createError({
        code: errorCodes.artifactPayloadInvalid,
        message,
        retryable: true,
    });
}

const IMAGE_REF_PATTERN = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/u;

export class ArtifactImageStore {
    readonly #root: string;

    constructor(storageDir: string) {
        this.#root = join(storageDir, "images");
    }

    async initialize(): Promise<void> {
        await mkdir(this.#root, { mode: 0o700, recursive: true });
        await chmod(this.#root, 0o700).catch(() => undefined);
    }

    async persist(
        bytes: Buffer,
        mediaType: ArtifactImageMediaType,
    ): Promise<ArtifactStoredImageResult> {
        const blake3 = await artifactBlake3(bytes);
        const imageRef = `${blake3}.${extensionForMediaType(mediaType)}`;
        const directory = join(this.#root, blake3.slice(0, 2));
        const path = join(directory, imageRef);
        await mkdir(directory, { mode: 0o700, recursive: true });
        try {
            await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
            if (!isNodeError(error, "EEXIST")) throw error;
        }
        await chmod(path, 0o600).catch(() => undefined);
        return result(blake3, imageRef, mediaType, bytes);
    }

    async read(imageRef: string): Promise<ArtifactStoredImageResult> {
        const parsed = parseImageRef(imageRef);
        const path = join(this.#root, parsed.blake3.slice(0, 2), imageRef);
        let bytes: Buffer;
        try {
            bytes = await readFile(path);
        } catch (error) {
            if (isNodeError(error, "ENOENT"))
                throw unavailable(
                    imageRef,
                    "Stored artifact image is unavailable.",
                );
            throw error;
        }
        const actualBlake3 = await artifactBlake3(bytes);
        if (actualBlake3 !== parsed.blake3) {
            throw unavailable(
                imageRef,
                "Stored artifact image failed its content hash check.",
            );
        }
        return result(
            parsed.blake3,
            imageRef,
            mediaTypeForExtension(parsed.extension),
            bytes,
        );
    }
}

function parseImageRef(imageRef: string): {
    blake3: string;
    extension: "gif" | "jpg" | "png" | "webp";
} {
    const match = IMAGE_REF_PATTERN.exec(imageRef);
    if (match === null) {
        throw createError({
            code: errorCodes.targetInvalid,
            details: { imageRef },
            message: "Invalid artifact image reference.",
            retryable: false,
        });
    }
    return {
        blake3: match[1]!,
        extension: match[2]! as "gif" | "jpg" | "png" | "webp",
    };
}

function extensionForMediaType(
    mediaType: ArtifactImageMediaType,
): "gif" | "jpg" | "png" | "webp" {
    switch (mediaType) {
        case "image/gif":
            return "gif";
        case "image/jpeg":
            return "jpg";
        case "image/png":
            return "png";
        case "image/webp":
            return "webp";
    }
}

function mediaTypeForExtension(
    extension: "gif" | "jpg" | "png" | "webp",
): ArtifactImageMediaType {
    switch (extension) {
        case "gif":
            return "image/gif";
        case "jpg":
            return "image/jpeg";
        case "png":
            return "image/png";
        case "webp":
            return "image/webp";
    }
}

function result(
    blake3: string,
    imageRef: string,
    mediaType: ArtifactImageMediaType,
    bytes: Buffer,
): ArtifactStoredImageResult {
    return {
        blake3,
        bytes: bytes.length,
        content: bytes.toString("base64"),
        encoding: "base64",
        imageRef,
        mediaType,
    };
}

function unavailable(imageRef: string, message: string) {
    return createError({
        code: errorCodes.artifactContentUnavailable,
        details: { imageRef },
        message,
        retryable: false,
    });
}

function isNodeError(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === code
    );
}
