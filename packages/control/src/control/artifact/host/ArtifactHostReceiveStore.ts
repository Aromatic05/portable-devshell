import { constants } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    writeFile
} from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
    WorkerArtifactReceiveBeginInput,
    WorkerArtifactReceiveBeginResult,
    WorkerArtifactReceiveFinishResult,
    WorkerArtifactReceiveWriteInput,
    WorkerArtifactReceiveWriteResult
} from "@portable-devshell/core";
import { createError, type ArtifactPayloadDescriptor } from "@portable-devshell/shared";

import { extractArtifactDirectoryArchive } from "./ArtifactHostArchive.js";
import { artifactHashFile } from "./ArtifactHostHash.js";

const RECORD_VERSION = 1;

interface StoredReceive {
    backupPath?: string;
    descriptor: ArtifactPayloadDescriptor;
    overwrite: boolean;
    phase: "receiving" | "verifying" | "committing";
    receiveId: string;
    receivedBytes: number;
    stagedPath?: string;
    targetPath: string;
    temporaryPath: string;
    version: number;
}

export class ArtifactHostReceiveStore {
    readonly #downloadDirectory: string;
    readonly #root: string;

    constructor(options: { downloadDirectory: string; root: string }) {
        this.#downloadDirectory = options.downloadDirectory;
        this.#root = options.root;
    }

    async initialize(): Promise<void> {
        await mkdir(this.#downloadDirectory, { mode: 0o700, recursive: true });
        await mkdir(this.#root, { mode: 0o700, recursive: true });
        await chmod(this.#root, 0o700).catch(() => undefined);
        for (const file of await readdir(this.#root).catch(() => [] as string[])) {
            if (!file.endsWith(".json")) {
                continue;
            }
            const receiveId = file.slice(0, -5);
            try {
                const stored = await this.#load(receiveId);
                await this.#recover(stored);
            } catch {
                await rm(join(this.#root, file), { force: true });
            }
        }
        for (const name of await readdir(this.#downloadDirectory)) {
            if (name.startsWith(".devshell-receive-")) {
                await rm(join(this.#downloadDirectory, name), {
                    force: true,
                    recursive: true
                });
            }
        }
    }

    async begin(input: WorkerArtifactReceiveBeginInput): Promise<WorkerArtifactReceiveBeginResult> {
        validateDescriptor(input.descriptor);
        const targetName = resolveTargetName(input.targetPath, input.descriptor);
        const targetPath = join(this.#downloadDirectory, targetName);
        const targetMetadata = await lstat(targetPath).catch(() => undefined);
        if (targetMetadata?.isSymbolicLink()) {
            throw artifactError(
                "artifact.directoryUnsafe",
                "Host Download target must not be a symbolic link."
            );
        }
        if (targetMetadata !== undefined && !input.overwrite) {
            throw artifactError("artifact.targetExists", "Host Download target already exists.");
        }

        const receiveId = randomUUID();
        const temporaryPath = join(this.#downloadDirectory, `.devshell-receive-${receiveId}.payload`);
        const temporary = await open(
            temporaryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600
        );
        await temporary.close();
        const stored: StoredReceive = {
            descriptor: input.descriptor,
            overwrite: input.overwrite,
            phase: "receiving",
            receiveId,
            receivedBytes: 0,
            targetPath,
            temporaryPath,
            version: RECORD_VERSION
        };
        try {
            await this.#persist(stored);
        } catch (error) {
            await rm(temporaryPath, { force: true });
            throw error;
        }
        return { nextOffsetBytes: 0, receiveId };
    }

    async write(input: WorkerArtifactReceiveWriteInput): Promise<WorkerArtifactReceiveWriteResult> {
        validateId(input.receiveId);
        const stored = await this.#load(input.receiveId);
        if (stored.phase !== "receiving") {
            throw artifactError(
                "artifact.receiveStateConflict",
                "Host receive is not accepting payload chunks."
            );
        }
        if (input.offsetBytes !== stored.receivedBytes) {
            throw artifactError(
                "artifact.receiveOffsetMismatch",
                `Expected offset ${stored.receivedBytes}, received ${input.offsetBytes}.`
            );
        }
        const bytes = decodeBase64(input.content);
        if (stored.receivedBytes + bytes.length > stored.descriptor.payloadBytes) {
            throw artifactError(
                "artifact.payloadInvalid",
                "Host receive exceeds the declared payload size."
            );
        }
        const file = await open(stored.temporaryPath, "r+");
        try {
            let written = 0;
            while (written < bytes.length) {
                const result = await file.write(
                    bytes,
                    written,
                    bytes.length - written,
                    input.offsetBytes + written
                );
                if (result.bytesWritten <= 0) {
                    throw artifactError(
                        "artifact.receiveFailed",
                        "Host receive stopped making progress."
                    );
                }
                written += result.bytesWritten;
            }
            await file.sync();
        } finally {
            await file.close();
        }
        stored.receivedBytes += bytes.length;
        await this.#persist(stored);
        return {
            nextOffsetBytes: stored.receivedBytes,
            receivedBytes: stored.receivedBytes,
            receiveId: stored.receiveId
        };
    }

    async finish(receiveId: string): Promise<WorkerArtifactReceiveFinishResult> {
        validateId(receiveId);
        const stored = await this.#load(receiveId);
        if (stored.phase !== "receiving") {
            throw artifactError(
                "artifact.receiveStateConflict",
                "Host receive cannot be finished from its current state."
            );
        }
        if (stored.receivedBytes !== stored.descriptor.payloadBytes) {
            throw artifactError(
                "artifact.payloadInvalid",
                `Received ${stored.receivedBytes} bytes but expected ${stored.descriptor.payloadBytes}.`
            );
        }
        stored.phase = "verifying";
        await this.#persist(stored);
        const payload = await artifactHashFile(stored.temporaryPath);
        if (
            payload.bytes !== stored.descriptor.payloadBytes ||
            payload.blake3 !== stored.descriptor.payloadBlake3
        ) {
            throw artifactError(
                "artifact.payloadInvalid",
                "Host receive payload checksum does not match the descriptor."
            );
        }

        let sourcePath = stored.temporaryPath;
        if (stored.descriptor.type === "directoryArchive") {
            const stagedPath = join(
                this.#downloadDirectory,
                `.devshell-receive-${receiveId}.directory`
            );
            await rm(stagedPath, { force: true, recursive: true });
            await mkdir(stagedPath, { mode: 0o700 });
            stored.stagedPath = stagedPath;
            await this.#persist(stored);
            const manifest = await extractArtifactDirectoryArchive(
                stored.temporaryPath,
                stagedPath
            ).catch(async (error) => {
                await rm(stagedPath, { force: true, recursive: true });
                throw error;
            });
            if (
                manifest.entryCount !== stored.descriptor.entryCount ||
                manifest.logicalBytes !== stored.descriptor.logicalBytes ||
                manifest.manifestBlake3 !== stored.descriptor.manifestBlake3
            ) {
                await rm(stagedPath, { force: true, recursive: true });
                throw artifactError(
                    "artifact.payloadInvalid",
                    "Restored host directory manifest does not match the descriptor."
                );
            }
            sourcePath = stagedPath;
        }

        stored.phase = "committing";
        await this.#persist(stored);
        await this.#commit(stored, sourcePath);
        await rm(stored.temporaryPath, { force: true });
        await rm(this.#metadataPath(receiveId), { force: true });
        return {
            blake3: payload.blake3,
            bytes: payload.bytes,
            receiveId,
            targetPath: stored.targetPath
        };
    }

    async abort(receiveId: string): Promise<void> {
        validateId(receiveId);
        const stored = await this.#load(receiveId).catch(() => undefined);
        if (stored === undefined) {
            return;
        }
        await this.#recover(stored);
    }

    async #commit(stored: StoredReceive, sourcePath: string): Promise<void> {
        const targetMetadata = await lstat(stored.targetPath).catch(() => undefined);
        if (targetMetadata?.isSymbolicLink()) {
            throw artifactError(
                "artifact.directoryUnsafe",
                "Host Download target must not be a symbolic link."
            );
        }
        if (targetMetadata !== undefined && !stored.overwrite) {
            throw artifactError("artifact.targetExists", "Host Download target already exists.");
        }
        if (targetMetadata !== undefined) {
            const backupPath = join(
                this.#downloadDirectory,
                `.devshell-receive-${stored.receiveId}.backup`
            );
            await rm(backupPath, { force: true, recursive: true });
            stored.backupPath = backupPath;
            await this.#persist(stored);
            await rename(stored.targetPath, backupPath);
            try {
                await rename(sourcePath, stored.targetPath);
            } catch (error) {
                await rename(backupPath, stored.targetPath).catch(() => undefined);
                throw error;
            }
            await rm(backupPath, { force: true, recursive: true });
            stored.backupPath = undefined;
            await syncDirectory(this.#downloadDirectory);
            return;
        }
        await rename(sourcePath, stored.targetPath);
        await syncDirectory(this.#downloadDirectory);
    }

    async #recover(stored: StoredReceive): Promise<void> {
        if (stored.backupPath !== undefined) {
            const targetExists = (await lstat(stored.targetPath).catch(() => undefined)) !== undefined;
            const backupExists = (await lstat(stored.backupPath).catch(() => undefined)) !== undefined;
            if (backupExists && !targetExists) {
                await rename(stored.backupPath, stored.targetPath);
            } else if (backupExists) {
                await rm(stored.backupPath, { force: true, recursive: true });
            }
        }
        await rm(stored.temporaryPath, { force: true });
        if (stored.stagedPath !== undefined) {
            await rm(stored.stagedPath, { force: true, recursive: true });
        }
        await rm(this.#metadataPath(stored.receiveId), { force: true });
    }

    async #load(receiveId: string): Promise<StoredReceive> {
        let value: unknown;
        try {
            value = JSON.parse(await readFile(this.#metadataPath(receiveId), "utf8"));
        } catch {
            throw artifactError("artifact.receiveNotFound", "Host receive is unavailable.");
        }
        if (!isStoredReceive(value, receiveId)) {
            throw artifactError("artifact.receiveNotFound", "Host receive metadata is invalid.");
        }
        return value;
    }

    async #persist(stored: StoredReceive): Promise<void> {
        const path = this.#metadataPath(stored.receiveId);
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
        await rename(temporary, path).catch(async (error) => {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        });
    }

    #metadataPath(receiveId: string): string {
        return join(this.#root, `${receiveId}.json`);
    }
}

async function syncDirectory(path: string): Promise<void> {
    if (process.platform === "win32") {
        return;
    }
    const directory = await open(path, "r");
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

function resolveTargetName(
    targetPath: string,
    descriptor: ArtifactPayloadDescriptor
): string {
    const normalized = targetPath.replace(/[\\/]+$/u, "");
    const requested = basename(normalized);
    if (isSafeBasename(requested)) {
        return requested;
    }
    const fallback =
        descriptor.type === "directoryArchive" && descriptor.name.endsWith(".tar.zst")
            ? descriptor.name.slice(0, -8)
            : descriptor.name;
    if (!isSafeBasename(fallback)) {
        throw artifactError("artifact.invalidTarget", "Host target has no safe file name.");
    }
    return fallback;
}

function isSafeBasename(value: string): boolean {
    return (
        value.length > 0 &&
        value !== "." &&
        value !== ".." &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !value.includes("\0")
    );
}

function decodeBase64(content: string): Buffer {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content)) {
        throw artifactError("artifact.payloadInvalid", "Host receive chunk is not valid base64.");
    }
    return Buffer.from(content, "base64");
}

function validateDescriptor(descriptor: ArtifactPayloadDescriptor): void {
    if (
        descriptor.name.length === 0 ||
        descriptor.mediaType.length === 0 ||
        !Number.isSafeInteger(descriptor.payloadBytes) ||
        descriptor.payloadBytes < 0 ||
        !/^[0-9a-f]{64}$/u.test(descriptor.payloadBlake3)
    ) {
        throw artifactError("artifact.payloadInvalid", "Artifact payload descriptor is invalid.");
    }
    if (
        descriptor.type === "directoryArchive" &&
        (typeof descriptor.entryCount !== "number" ||
            !Number.isSafeInteger(descriptor.entryCount) ||
            typeof descriptor.logicalBytes !== "number" ||
            !Number.isSafeInteger(descriptor.logicalBytes) ||
            typeof descriptor.manifestBlake3 !== "string" ||
            !/^[0-9a-f]{64}$/u.test(descriptor.manifestBlake3))
    ) {
        throw artifactError(
            "artifact.payloadInvalid",
            "Directory payload descriptor is incomplete."
        );
    }
}

function validateId(value: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
        throw artifactError("artifact.invalidReceiveId", "receiveId is invalid.");
    }
}

function isStoredReceive(value: unknown, receiveId: string): value is StoredReceive {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Partial<StoredReceive>;
    return (
        record.version === RECORD_VERSION &&
        record.receiveId === receiveId &&
        typeof record.targetPath === "string" &&
        typeof record.temporaryPath === "string" &&
        typeof record.receivedBytes === "number" &&
        typeof record.descriptor === "object" &&
        record.descriptor !== null
    );
}

function artifactError(code: string, message: string) {
    return createError({ code, message, retryable: false });
}
