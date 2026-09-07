import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type {
    ExtensionDataBundle,
    ExtensionDataCapability
} from "@portable-devshell/extension";

import { extractArtifactDirectoryArchive } from "../artifact/host/ArtifactHostArchive.js";
import {
    resolveExtensionInstallLimits,
    type ExtensionInstallLimits
} from "./ExtensionInstallPolicy.js";

export interface ExtensionDataCapabilityControlOptions {
    allowed: boolean;
    dataDirectory: string;
    extensionId: string;
    limits?: Partial<ExtensionInstallLimits>;
}

export class ExtensionDataCapabilityControl implements ExtensionDataCapability {
    readonly #allowed: boolean;
    readonly #dataDirectory: string;
    readonly #extensionId: string;
    readonly #limits: ExtensionInstallLimits;

    constructor(options: ExtensionDataCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#dataDirectory = options.dataDirectory;
        this.#extensionId = options.extensionId;
        this.#limits = resolveExtensionInstallLimits(options.limits);
    }

    async installBundle(sourcePath: string): Promise<ExtensionDataBundle> {
        this.#assertAllowed();
        if (!isAbsolute(sourcePath)) {
            throw new TypeError("Extension data bundle source must be an absolute local path.");
        }
        const source = await lstat(sourcePath).catch((error: unknown) => {
            throw new Error("Extension data bundle source is unavailable.", { cause: error });
        });
        if (source.isSymbolicLink() || !source.isFile()) {
            throw new TypeError("Extension data bundle source must be a regular file, not a symlink.");
        }
        if (source.size > this.#limits.maxCompressedBytes) {
            throw new TypeError("Extension data bundle exceeds the compressed byte limit.");
        }

        const digest = await hashPlainFile(sourcePath, source.size);
        const generation = `sha256-${digest}`;
        const bundleRoot = join(this.#dataDirectory, "bundles");
        const destination = join(bundleRoot, generation);
        const staging = join(this.#dataDirectory, `.bundle-staging-${randomUUID()}`);
        await mkdir(bundleRoot, { mode: 0o700, recursive: true });
        await assertPlainDirectory(bundleRoot, "Extension data bundle root");
        await mkdir(staging, { mode: 0o700 });

        try {
            await extractArtifactDirectoryArchive(sourcePath, staging, this.#limits);
            const existing = await lstat(destination).catch((error: unknown) => {
                if (isMissing(error)) return undefined;
                throw error;
            });
            if (existing === undefined) {
                try {
                    await rename(staging, destination);
                } catch (error) {
                    if (!isAlreadyExists(error)) throw error;
                    await assertPlainDirectory(destination, `Extension data bundle ${generation}`);
                }
            } else {
                if (existing.isSymbolicLink() || !existing.isDirectory()) {
                    throw new TypeError(`Extension data bundle generation is not a plain directory: ${generation}.`);
                }
            }
            return Object.freeze({ directory: destination, generation });
        } finally {
            await rm(staging, { force: true, recursive: true }).catch(() => undefined);
        }
    }

    async removeBundle(generation: string): Promise<void> {
        this.#assertAllowed();
        assertBundleGeneration(generation);
        const destination = join(this.#dataDirectory, "bundles", generation);
        const metadata = await lstat(destination).catch((error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
        });
        if (metadata === undefined) return;
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new TypeError(`Extension data bundle generation is not a plain directory: ${generation}.`);
        }
        await rm(destination, { force: true, recursive: true });
    }

    #assertAllowed(): void {
        if (!this.#allowed) {
            throw new Error(`Extension ${this.#extensionId} did not declare the data capability.`);
        }
    }
}

async function hashPlainFile(path: string, expectedSize: number): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const current = await handle.stat();
        if (!current.isFile() || current.size !== expectedSize) {
            throw new Error("Extension data bundle changed while being read.");
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < current.size) {
            const requested = Math.min(buffer.length, current.size - position);
            const { bytesRead } = await handle.read(buffer, 0, requested, position);
            if (bytesRead <= 0) throw new Error("Extension data bundle changed while being read.");
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        return hash.digest("hex");
    } finally {
        await handle.close();
    }
}

function assertBundleGeneration(value: string): void {
    if (!/^sha256-[0-9a-f]{64}$/u.test(value)) {
        throw new TypeError(`Invalid Extension data bundle generation: ${value}.`);
    }
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TypeError(`${label} must be a plain directory.`);
    }
}

function isMissing(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EEXIST" || code === "ENOTEMPTY";
}
