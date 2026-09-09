import { constants } from "node:fs";
import {
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
    parseExtensionManifest,
    type ExtensionManifest
} from "@portable-devshell/extension";
import {
    createError,
    errorCodes,
    type ExtensionRemoveResult,
    type ExtensionRuntimeRecord
} from "@portable-devshell/shared";

import {
    createArtifactDirectoryArchive,
    extractArtifactDirectoryArchive
} from "../../artifact/host/ArtifactHostArchive.js";
import {
    resolveExtensionInstallLimits,
    type ExtensionInstallLimits
} from "./ExtensionInstallPolicy.js";
import type { ExtensionPathLayout } from "../state/ExtensionPathLayout.js";

export const BUILTIN_EXTENSION_IDS = new Set(["artifact", "instance", "mcp", "secret", "skill"]);

export interface ExtensionInstallHost {
    disable(id: string): Promise<void>;
    forget(id: string): Promise<void>;
    list(): Promise<ExtensionRuntimeRecord[]>;
    selectGeneration(id: string, generation: string): Promise<void>;
    waitForDrain(id: string): Promise<void>;
}

export interface ExtensionInstallServiceOptions {
    host: ExtensionInstallHost;
    limits?: Partial<ExtensionInstallLimits>;
    paths: ExtensionPathLayout;
}

export class ExtensionInstallService {
    readonly #host: ExtensionInstallHost;
    readonly #limits: ExtensionInstallLimits;
    readonly #paths: ExtensionPathLayout;

    constructor(options: ExtensionInstallServiceOptions) {
        this.#host = options.host;
        this.#paths = options.paths;
        this.#limits = resolveExtensionInstallLimits(options.limits);
    }

    async install(sourcePath: string): Promise<ExtensionRuntimeRecord> {
        return await this.#install(sourcePath);
    }

    async installBuiltin(id: string, sourcePath: string): Promise<ExtensionRuntimeRecord> {
        if (!BUILTIN_EXTENSION_IDS.has(id)) {
            throw extensionInstallError(`Extension id ${id} is not a registered builtin.`);
        }
        return await this.#install(sourcePath, id);
    }

    async #install(sourcePath: string, builtinId?: string): Promise<ExtensionRuntimeRecord> {
        if (!isAbsolute(sourcePath)) {
            throw extensionInstallError("Extension install source must be an absolute local path.");
        }
        await mkdir(this.#paths.codeRoot, { mode: 0o700, recursive: true });
        await assertPlainDirectory(this.#paths.codeRoot, "Extension code root");

        const transactionId = randomUUID();
        const stagingDirectory = join(this.#paths.codeRoot, `.staging-${transactionId}`);
        const canonicalArchive = join(this.#paths.codeRoot, `.staging-${transactionId}.dsext`);
        await mkdir(stagingDirectory, { mode: 0o700 });
        let ownsArchive = false;
        let installedDirectory: string | undefined;
        let installedDirectoryCreated = false;

        try {
            const source = await lstat(sourcePath).catch((error: unknown) => {
                throw extensionInstallError("Extension install source is unavailable.", error);
            });
            if (source.isSymbolicLink()) {
                throw extensionInstallError("Extension install source must not be a symbolic link.");
            }

            let archivePath: string;
            if (source.isDirectory()) {
                await hashExtensionDirectory(sourcePath, this.#limits);
                await createArtifactDirectoryArchive(sourcePath, canonicalArchive);
                ownsArchive = true;
                archivePath = canonicalArchive;
            } else if (source.isFile()) {
                if (source.size > this.#limits.maxCompressedBytes) {
                    throw extensionInstallError("Extension bundle exceeds the compressed byte limit.");
                }
                archivePath = sourcePath;
            } else {
                throw extensionInstallError("Extension install source must be a directory or .dsext archive.");
            }

            await extractArtifactDirectoryArchive(archivePath, stagingDirectory, this.#limits);
            const manifest = await readStagedManifest(stagingDirectory);
            assertInstallableManifest(manifest, builtinId);
            const digest = await hashExtensionDirectory(stagingDirectory, this.#limits);
            const generation = generationName(manifest.version, digest);
            const extensionDirectory = join(this.#paths.codeRoot, manifest.id);
            installedDirectory = this.#paths.generationDirectory(manifest.id, generation);
            await mkdir(extensionDirectory, { mode: 0o700, recursive: true });
            await assertPlainDirectory(extensionDirectory, `Extension directory for ${manifest.id}`);

            const existing = await lstat(installedDirectory).catch((error: unknown) => {
                if (isMissing(error)) return undefined;
                throw error;
            });
            if (existing === undefined) {
                await rename(stagingDirectory, installedDirectory);
                installedDirectoryCreated = true;
            } else {
                if (existing.isSymbolicLink() || !existing.isDirectory()) {
                    throw extensionInstallError(`Extension generation path is not a directory: ${generation}.`);
                }
                const existingDigest = await hashExtensionDirectory(installedDirectory, this.#limits);
                if (existingDigest !== digest) {
                    throw extensionInstallError(`Extension generation ${generation} is corrupt or collides with different bytes.`);
                }
                await rm(stagingDirectory, { force: true, recursive: true });
            }

            const current = (await this.#host.list()).find((record) => record.id === manifest.id);
            if (
                !installedDirectoryCreated
                && current?.enabled === true
                && current.selectedGeneration === generation
                && (current.state === "installed" || current.state === "active")
            ) {
                return current;
            }

            try {
                await this.#host.selectGeneration(manifest.id, generation);
            } catch (error) {
                if (installedDirectoryCreated) {
                    await rm(installedDirectory, { force: true, recursive: true }).catch(() => undefined);
                }
                throw error;
            }
            return await requireRuntimeRecord(this.#host, manifest.id);
        } finally {
            await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined);
            if (ownsArchive) {
                await rm(canonicalArchive, { force: true }).catch(() => undefined);
            }
        }
    }

    async remove(id: string, purge = false): Promise<ExtensionRemoveResult> {
        await this.#host.disable(id);
        await this.#host.waitForDrain(id);
        await this.#host.forget(id);
        const failures: unknown[] = [];
        await rm(join(this.#paths.codeRoot, id), { force: true, recursive: true }).catch((error) => failures.push(error));
        await rm(join(this.#paths.runtimeRoot, id), { force: true, recursive: true }).catch((error) => failures.push(error));
        if (purge) {
            await rm(this.#paths.stateDirectory(id), { force: true, recursive: true }).catch((error) => failures.push(error));
            await rm(this.#paths.dataDirectory(id), { force: true, recursive: true }).catch((error) => failures.push(error));
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, `Extension ${id} was deregistered but filesystem cleanup was incomplete.`);
        }
        return { id, purged: purge, removed: true };
    }
}

async function readStagedManifest(directory: string): Promise<ExtensionManifest> {
    const path = join(directory, "devshell-extension.json");
    const metadata = await lstat(path).catch((error: unknown) => {
        throw extensionInstallError("Extension bundle is missing devshell-extension.json.", error);
    });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw extensionInstallError("Extension manifest must be a regular file.");
    }
    try {
        return parseExtensionManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error) {
        throw extensionInstallError("Extension manifest is invalid.", error);
    }
}

function assertInstallableManifest(manifest: ExtensionManifest, builtinId?: string): void {
    if (builtinId === undefined && BUILTIN_EXTENSION_IDS.has(manifest.id)) {
        throw extensionInstallError(`Extension id ${manifest.id} is reserved for a builtin Extension.`);
    }
    if (builtinId !== undefined && manifest.id !== builtinId) {
        throw extensionInstallError(`Builtin Extension source declares id ${manifest.id}, expected ${builtinId}.`);
    }
}

async function hashExtensionDirectory(root: string, limits: ExtensionInstallLimits): Promise<string> {
    const hash = createHash("sha256");
    let entries = 0;
    let logicalBytes = 0;

    const walk = async (directory: string, prefix: string): Promise<void> => {
        const children = await readdir(directory, { withFileTypes: true });
        children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
        for (const child of children) {
            const absolute = join(directory, child.name);
            const relative = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
            if (relative.split("/").includes("node_modules")) {
                throw extensionInstallError(
                    `Extension source must use shared host dependencies instead of private node_modules: ${relative}.`
                );
            }
            const metadata = await lstat(absolute);
            if (metadata.isSymbolicLink()) {
                throw extensionInstallError(`Extension source contains symbolic link: ${relative}.`);
            }
            entries += 1;
            if (limits.maxEntries !== undefined && entries > limits.maxEntries) {
                throw extensionInstallError("Extension source exceeds the entry limit.");
            }
            if (metadata.isDirectory()) {
                hash.update(`D\0${relative}\0${metadata.mode & 0o777}\0`);
                await walk(absolute, relative);
                continue;
            }
            if (!metadata.isFile()) {
                throw extensionInstallError(`Extension source contains unsupported member: ${relative}.`);
            }
            if (limits.maxFileBytes !== undefined && metadata.size > limits.maxFileBytes) {
                throw extensionInstallError(`Extension file exceeds the byte limit: ${relative}.`);
            }
            logicalBytes += metadata.size;
            if (limits.maxLogicalBytes !== undefined && logicalBytes > limits.maxLogicalBytes) {
                throw extensionInstallError("Extension source exceeds the logical byte limit.");
            }
            hash.update(`F\0${relative}\0${metadata.mode & 0o777}\0${metadata.size}\0`);
            const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const current = await handle.stat();
                if (!current.isFile() || current.size !== metadata.size) {
                    throw extensionInstallError(`Extension source changed while hashing: ${relative}.`);
                }
                const buffer = Buffer.allocUnsafe(64 * 1024);
                let position = 0;
                while (position < current.size) {
                    const requested = Math.min(buffer.length, current.size - position);
                    const { bytesRead } = await handle.read(buffer, 0, requested, position);
                    if (bytesRead <= 0) {
                        throw extensionInstallError(`Extension source changed while hashing: ${relative}.`);
                    }
                    hash.update(buffer.subarray(0, bytesRead));
                    position += bytesRead;
                }
            } finally {
                await handle.close();
            }
        }
    };

    await walk(root, "");
    return hash.digest("hex");
}

function generationName(version: string, digest: string): string {
    const safeVersion = version
        .replace(/[^A-Za-z0-9._-]+/gu, "_")
        .replace(/^[^A-Za-z0-9]+/u, "")
        .slice(0, 80) || "unknown";
    return `v${safeVersion}-${digest}`;
}

async function requireRuntimeRecord(host: ExtensionInstallHost, id: string): Promise<ExtensionRuntimeRecord> {
    const record = (await host.list()).find((candidate) => candidate.id === id);
    if (record !== undefined) return record;
    throw extensionInstallError(`Extension ${id} activated but is missing from the runtime registry.`);
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw extensionInstallError(`${label} must be a real directory, not a symlink.`);
    }
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function extensionInstallError(message: string, cause?: unknown): Error {
    return createError({
        code: errorCodes.controlExtensionInvalid,
        cause,
        message: cause instanceof Error ? `${message} ${cause.message}` : message,
        retryable: false
    });
}
