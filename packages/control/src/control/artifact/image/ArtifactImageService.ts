import {
    createError,
    errorCodes,
    type ArtifactImageMediaType,
    type ArtifactViewImageInput,
    type ArtifactViewImageResult
} from "@portable-devshell/shared";

import {
    readImagePayloadSourceInput,
    readSourceInstance,
    sourceDescriptor
} from "../ArtifactSource.js";
import {
    DEFAULT_ARTIFACT_CHUNK_BYTES,
    requireArtifactEndpoint,
    type ArtifactServiceOptions
} from "../ArtifactServiceModel.js";

export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;
const ARTIFACT_IMAGE_PAYLOAD_TTL_MS = 5 * 60 * 1000;
const MAX_ARTIFACT_IMAGE_CHUNK_BYTES = 1024 * 1024;

export class ArtifactImageService {
    readonly #chunkBytes: number;
    readonly #resolveEndpoint: ArtifactServiceOptions["resolveEndpoint"];

    constructor(options: Pick<ArtifactServiceOptions, "chunkBytes" | "resolveEndpoint">) {
        const requestedChunkBytes = options.chunkBytes;
        this.#chunkBytes =
            typeof requestedChunkBytes === "number" &&
            Number.isSafeInteger(requestedChunkBytes) &&
            requestedChunkBytes > 0
                ? Math.min(requestedChunkBytes, MAX_ARTIFACT_IMAGE_CHUNK_BYTES)
                : DEFAULT_ARTIFACT_CHUNK_BYTES;
        this.#resolveEndpoint = options.resolveEndpoint;
    }

    async view(
        input: ArtifactViewImageInput,
        defaultInstance: string,
        signal?: AbortSignal
    ): Promise<ArtifactViewImageResult> {
        throwIfAborted(signal);
        const sourceInstance = readSourceInstance(input.instance, defaultInstance);
        const endpoint = requireArtifactEndpoint(
            this.#resolveEndpoint,
            sourceInstance,
            defaultInstance
        );
        const sourceInput = readImagePayloadSourceInput(input);
        const opened = await endpoint.openArtifactPayload({
            ...sourceInput,
            expiresAtMs: Date.now() + ARTIFACT_IMAGE_PAYLOAD_TTL_MS
        });

        try {
            if (opened.descriptor.type === "directoryArchive") {
                throw unsupported("Artifact image source must be a file or byte artifact.");
            }
            if (opened.descriptor.payloadBytes <= 0) {
                throw unsupported("Artifact image source is empty.");
            }
            if (opened.descriptor.payloadBytes > MAX_ARTIFACT_IMAGE_BYTES) {
                throw createError({
                    code: errorCodes.artifactImageTooLarge,
                    details: {
                        bytes: opened.descriptor.payloadBytes,
                        maxBytes: MAX_ARTIFACT_IMAGE_BYTES
                    },
                    message: `Artifact image exceeds the ${MAX_ARTIFACT_IMAGE_BYTES}-byte limit.`,
                    retryable: false
                });
            }

            const bytes = await this.#readPayload(
                endpoint,
                opened.payloadId,
                opened.descriptor.payloadBytes,
                signal
            );
            const mediaType = detectArtifactImageMediaType(bytes.subarray(0, 16));

            return {
                bytes: bytes.length,
                content: bytes.toString("base64"),
                encoding: "base64",
                mediaType,
                name: opened.descriptor.name,
                source: sourceDescriptor(sourceInstance, sourceInput, opened.descriptor)
            };
        } finally {
            await endpoint.closeArtifactPayload(opened.payloadId).catch(() => undefined);
        }
    }

    async #readPayload(
        endpoint: ReturnType<typeof requireArtifactEndpoint>,
        payloadId: string,
        totalBytes: number,
        signal?: AbortSignal
    ): Promise<Buffer> {
        const chunks: Buffer[] = [];
        let offsetBytes = 0;

        while (offsetBytes < totalBytes) {
            throwIfAborted(signal);
            const chunk = await endpoint.readArtifactPayload({
                maxBytes: Math.min(this.#chunkBytes, totalBytes - offsetBytes),
                offsetBytes,
                payloadId
            });
            throwIfAborted(signal);
            validateChunk(chunk, payloadId, offsetBytes, totalBytes);
            const decoded = Buffer.from(chunk.content, "base64");
            if (decoded.length !== chunk.returnedBytes) {
                throw invalidPayload("Artifact image payload returned an invalid base64 chunk.");
            }
            chunks.push(decoded);
            offsetBytes += decoded.length;
        }

        const result = Buffer.concat(chunks, totalBytes);
        if (result.length !== totalBytes) {
            throw invalidPayload("Artifact image payload length changed during reading.");
        }
        return result;
    }
}

export function detectArtifactImageMediaType(header: Uint8Array): ArtifactImageMediaType {
    const bytes = Buffer.from(header);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
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
    throw unsupported("Unsupported artifact image format; expected PNG, JPEG, GIF, or WebP.");
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
    expectedTotal: number
): void {
    if (
        chunk.payloadId !== payloadId ||
        chunk.offsetBytes !== expectedOffset ||
        chunk.totalBytes !== expectedTotal ||
        !Number.isSafeInteger(chunk.returnedBytes) ||
        chunk.returnedBytes <= 0 ||
        chunk.returnedBytes > expectedTotal - expectedOffset
    ) {
        throw invalidPayload("Artifact image payload returned inconsistent chunk metadata.");
    }
    const expectedNext = expectedOffset + chunk.returnedBytes;
    if (chunk.eof !== (expectedNext >= expectedTotal)) {
        throw invalidPayload("Artifact image payload returned an inconsistent eof marker.");
    }
    if (!chunk.eof && chunk.nextOffsetBytes !== expectedNext) {
        throw invalidPayload("Artifact image payload returned an unexpected next offset.");
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
            reason: typeof signal.reason === "string" ? signal.reason : "client cancelled"
        },
        message: "Artifact image viewing was cancelled by the client.",
        retryable: true
    });
}

function unsupported(message: string) {
    return createError({
        code: errorCodes.artifactImageUnsupported,
        message,
        retryable: false
    });
}

function invalidPayload(message: string) {
    return createError({
        code: errorCodes.artifactPayloadInvalid,
        message,
        retryable: true
    });
}
