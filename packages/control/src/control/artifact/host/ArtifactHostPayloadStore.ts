import { constants } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    writeFile
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import type {
    WorkerArtifactPayloadOpenResult,
    WorkerArtifactPayloadReadResult
} from "@portable-devshell/core";
import { createError, type ArtifactPayloadDescriptor } from "@portable-devshell/shared";

import { createArtifactDirectoryArchive } from "./ArtifactHostArchive.js";
import { artifactHashFile, createArtifactHasher } from "./ArtifactHostHash.js";
import type { ArtifactHostAccessContext } from "./ArtifactHostModel.js";

const RECORD_VERSION = 1;
const MAX_READ_BYTES = 1024 * 1024;

interface StoredPayload {
    descriptor: ArtifactPayloadDescriptor;
    expiresAtMs: number;
    payloadId: string;
    version: number;
}

export class ArtifactHostPayloadStore {
    readonly #homeDirectory: string;
    readonly #processCwd: string;
    readonly #root: string;
    readonly #temporaryRoot: string;

    constructor(options: {
        homeDirectory: string;
        processCwd: string;
        root: string;
    }) {
        this.#homeDirectory = options.homeDirectory;
        this.#processCwd = options.processCwd;
        this.#root = options.root;
        this.#temporaryRoot = join(options.root, "tmp");
    }

    async initialize(): Promise<void> {
        await mkdir(this.#temporaryRoot, { mode: 0o700, recursive: true });
        await chmod(this.#root, 0o700).catch(() => undefined);
        await chmod(this.#temporaryRoot, 0o700).catch(() => undefined);
        await clearDirectory(this.#temporaryRoot);
        await this.#collectExpired();
    }

    async openPath(
        rawPath: string,
        expiresAtMs: number,
        context: ArtifactHostAccessContext
    ): Promise<WorkerArtifactPayloadOpenResult> {
        if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
            throw artifactError("artifact.invalidLease", "Host payload expiration must be in the future.");
        }
        const sourcePath = await resolveSourcePath(
            rawPath,
            context,
            this.#homeDirectory,
            this.#processCwd
        );
        const sourceMetadata = await lstat(sourcePath);
        if (sourceMetadata.isSymbolicLink()) {
            throw artifactError("artifact.directoryUnsafe", "Host source must not be a symbolic link.");
        }
        const payloadId = randomUUID();
        const temporaryPath = join(this.#temporaryRoot, `${payloadId}.tmp`);
        const dataPath = this.#dataPath(payloadId);
        let descriptor: ArtifactPayloadDescriptor;

        try {
            if (sourceMetadata.isFile()) {
                const { blake3, bytes } = await copyAndHashFile(sourcePath, temporaryPath);
                descriptor = {
                    mediaType: "application/octet-stream",
                    name: requireName(sourcePath),
                    payloadBlake3: blake3,
                    payloadBytes: bytes,
                    type: "file"
                };
            } else if (sourceMetadata.isDirectory()) {
                const manifest = await createArtifactDirectoryArchive(sourcePath, temporaryPath);
                const payload = await artifactHashFile(temporaryPath);
                descriptor = {
                    entryCount: manifest.entryCount,
                    logicalBytes: manifest.logicalBytes,
                    manifestBlake3: manifest.manifestBlake3,
                    mediaType: "application/zstd",
                    name: `${requireName(sourcePath)}.tar.zst`,
                    payloadBlake3: payload.blake3,
                    payloadBytes: payload.bytes,
                    type: "directoryArchive"
                };
            } else {
                throw artifactError(
                    "artifact.directoryUnsafe",
                    "Host source must be a regular file or directory."
                );
            }
            await rename(temporaryPath, dataPath);
            const stored: StoredPayload = {
                descriptor,
                expiresAtMs,
                payloadId,
                version: RECORD_VERSION
            };
            await atomicWriteJson(this.#metadataPath(payloadId), stored);
            return { descriptor, expiresAtMs, payloadId };
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            await rm(dataPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async read(
        payloadId: string,
        offsetBytes: number,
        maxBytes: number
    ): Promise<WorkerArtifactPayloadReadResult> {
        validateId(payloadId);
        if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
            throw artifactError("artifact.invalidOffset", "offsetBytes must be a non-negative integer.");
        }
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) {
            throw artifactError(
                "artifact.invalidArguments",
                `maxBytes must be between 1 and ${MAX_READ_BYTES}.`
            );
        }
        const stored = await this.#load(payloadId);
        if (stored.expiresAtMs <= Date.now()) {
            await this.close(payloadId);
            throw artifactError("artifact.payloadExpired", "Host payload has expired.");
        }
        if (offsetBytes > stored.descriptor.payloadBytes) {
            throw artifactError("artifact.invalidOffset", "offsetBytes exceeds payload size.");
        }
        const file = await open(this.#dataPath(payloadId), "r");
        try {
            const requested = Math.min(maxBytes, stored.descriptor.payloadBytes - offsetBytes);
            const buffer = Buffer.alloc(requested);
            const { bytesRead } = await file.read(buffer, 0, requested, offsetBytes);
            const nextOffsetBytes = offsetBytes + bytesRead;
            const eof = nextOffsetBytes >= stored.descriptor.payloadBytes;
            return {
                content: buffer.subarray(0, bytesRead).toString("base64"),
                encoding: "base64",
                eof,
                ...(eof ? {} : { nextOffsetBytes }),
                offsetBytes,
                payloadId,
                returnedBytes: bytesRead,
                totalBytes: stored.descriptor.payloadBytes
            };
        } finally {
            await file.close();
        }
    }

    async close(payloadId: string): Promise<void> {
        validateId(payloadId);
        await rm(this.#metadataPath(payloadId), { force: true });
        await rm(this.#dataPath(payloadId), { force: true });
    }

    async #collectExpired(): Promise<void> {
        const files = await readdir(this.#root).catch(() => [] as string[]);
        for (const file of files) {
            if (!file.endsWith(".json")) {
                continue;
            }
            const payloadId = file.slice(0, -5);
            try {
                const stored = await this.#load(payloadId);
                if (stored.expiresAtMs <= Date.now()) {
                    await this.close(payloadId);
                }
            } catch {
                await rm(join(this.#root, file), { force: true });
                await rm(this.#dataPath(payloadId), { force: true });
            }
        }
    }

    async #load(payloadId: string): Promise<StoredPayload> {
        validateId(payloadId);
        let value: unknown;
        try {
            value = JSON.parse(await readFile(this.#metadataPath(payloadId), "utf8"));
        } catch {
            throw artifactError("artifact.payloadNotFound", "Host payload is unavailable.");
        }
        if (!isStoredPayload(value, payloadId)) {
            throw artifactError("artifact.payloadNotFound", "Host payload metadata is invalid.");
        }
        const data = await stat(this.#dataPath(payloadId)).catch(() => undefined);
        if (data === undefined || !data.isFile() || data.size !== value.descriptor.payloadBytes) {
            throw artifactError("artifact.contentUnavailable", "Host payload content is unavailable.");
        }
        return value;
    }

    #dataPath(payloadId: string): string {
        return join(this.#root, `${payloadId}.bin`);
    }

    #metadataPath(payloadId: string): string {
        return join(this.#root, `${payloadId}.json`);
    }
}

async function resolveSourcePath(
    rawPath: string,
    context: ArtifactHostAccessContext,
    homeDirectory: string,
    processCwd: string
): Promise<string> {
    if (rawPath.length === 0) {
        throw artifactError("artifact.hostPathDenied", "Host source path must not be empty.");
    }
    const expanded =
        rawPath === "~"
            ? homeDirectory
            : rawPath.startsWith("~/")
              ? join(homeDirectory, rawPath.slice(2))
              : rawPath;
    const base =
        context.securityMode === "workspace" && context.provider === "local" && context.workspace !== undefined
            ? context.workspace
            : processCwd;
    const requested = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
    const requestedMetadata = await lstat(requested).catch((error: unknown) => {
        throw artifactError("artifact.hostPathDenied", "Host source path is unavailable.", error);
    });
    if (requestedMetadata.isSymbolicLink()) {
        throw artifactError("artifact.directoryUnsafe", "Host source must not be a symbolic link.");
    }
    const canonical = await realpath(requested);

    if (context.securityMode === "workspace") {
        if (context.provider !== "local" || context.workspace === undefined) {
            throw artifactError(
                "artifact.hostPathDenied",
                "Workspace-restricted host access requires a local instance workspace."
            );
        }
        const workspace = await realpath(context.workspace).catch((error: unknown) => {
            throw artifactError("artifact.hostPathDenied", "Instance workspace is unavailable on host.", error);
        });
        if (!isWithin(workspace, canonical)) {
            throw artifactError(
                "artifact.hostPathDenied",
                "Host source path is outside the authorized instance workspace."
            );
        }
    }
    return canonical;
}

async function copyAndHashFile(sourcePath: string, targetPath: string): Promise<{ blake3: string; bytes: number }> {
    const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const target = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const hasher = await createArtifactHasher();
    let bytes = 0;
    try {
        const sourceMetadata = await source.stat();
        if (!sourceMetadata.isFile()) {
            throw artifactError("artifact.directoryUnsafe", "Host source is not a regular file.");
        }
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (true) {
            const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                break;
            }
            const chunk = buffer.subarray(0, bytesRead);
            hasher.update(chunk);
            await writeAll(target, chunk);
            bytes += bytesRead;
        }
        await target.sync();
        return { blake3: hasher.digest("hex"), bytes };
    } finally {
        await Promise.allSettled([source.close(), target.close()]);
    }
}


async function writeAll(file: import("node:fs/promises").FileHandle, bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
        if (bytesWritten <= 0) {
            throw artifactError("artifact.storageFailed", "Host payload snapshot stopped making progress.");
        }
        offset += bytesWritten;
    }
}

function requireName(path: string): string {
    const name = basename(path);
    if (name.length === 0 || name === "." || name === "..") {
        throw artifactError("artifact.directoryUnsafe", "Host source has no usable file name.");
    }
    return name;
}

function isWithin(root: string, candidate: string): boolean {
    const child = relative(root, candidate);
    return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function validateId(value: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
        throw artifactError("artifact.invalidPayloadId", "payloadId is invalid.");
    }
}

function isStoredPayload(value: unknown, payloadId: string): value is StoredPayload {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Partial<StoredPayload>;
    return (
        record.version === RECORD_VERSION &&
        record.payloadId === payloadId &&
        typeof record.expiresAtMs === "number" &&
        typeof record.descriptor === "object" &&
        record.descriptor !== null &&
        typeof record.descriptor.payloadBytes === "number"
    );
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path).catch(async (error) => {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    });
}

async function clearDirectory(path: string): Promise<void> {
    for (const name of await readdir(path)) {
        await rm(join(path, name), { force: true, recursive: true });
    }
}

function artifactError(code: string, message: string, cause?: unknown) {
    return createError({
        code,
        message: cause instanceof Error ? `${message} ${cause.message}` : message,
        retryable: false
    });
}
