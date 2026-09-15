import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    createError,
    errorCodes,
    type ArtifactImageMediaType,
    type ArtifactStoredImageResult
} from "@portable-devshell/shared";

import { artifactBlake3 } from "../host/ArtifactHostHash.js";

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

    async persist(bytes: Buffer, mediaType: ArtifactImageMediaType): Promise<ArtifactStoredImageResult> {
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
            if (isNodeError(error, "ENOENT")) throw unavailable(imageRef, "Stored artifact image is unavailable.");
            throw error;
        }
        const actualBlake3 = await artifactBlake3(bytes);
        if (actualBlake3 !== parsed.blake3) {
            throw unavailable(imageRef, "Stored artifact image failed its content hash check.");
        }
        return result(parsed.blake3, imageRef, mediaTypeForExtension(parsed.extension), bytes);
    }
}

function parseImageRef(imageRef: string): { blake3: string; extension: "gif" | "jpg" | "png" | "webp" } {
    const match = IMAGE_REF_PATTERN.exec(imageRef);
    if (match === null) {
        throw createError({
            code: errorCodes.targetInvalid,
            details: { imageRef },
            message: "Invalid artifact image reference.",
            retryable: false
        });
    }
    return {
        blake3: match[1]!,
        extension: match[2]! as "gif" | "jpg" | "png" | "webp"
    };
}

function extensionForMediaType(mediaType: ArtifactImageMediaType): "gif" | "jpg" | "png" | "webp" {
    switch (mediaType) {
        case "image/gif": return "gif";
        case "image/jpeg": return "jpg";
        case "image/png": return "png";
        case "image/webp": return "webp";
    }
}

function mediaTypeForExtension(extension: "gif" | "jpg" | "png" | "webp"): ArtifactImageMediaType {
    switch (extension) {
        case "gif": return "image/gif";
        case "jpg": return "image/jpeg";
        case "png": return "image/png";
        case "webp": return "image/webp";
    }
}

function result(
    blake3: string,
    imageRef: string,
    mediaType: ArtifactImageMediaType,
    bytes: Buffer
): ArtifactStoredImageResult {
    return {
        blake3,
        bytes: bytes.length,
        content: bytes.toString("base64"),
        encoding: "base64",
        imageRef,
        mediaType
    };
}

function unavailable(imageRef: string, message: string) {
    return createError({
        code: errorCodes.artifactContentUnavailable,
        details: { imageRef },
        message,
        retryable: false
    });
}

function isNodeError(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
