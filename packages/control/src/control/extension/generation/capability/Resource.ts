import type {
    ExtensionArtifactCapability,
    ExtensionArtifactShareInput,
    ExtensionArtifactShareRecord,
    ExtensionArtifactShareRevokeResult,
    ExtensionArtifactSource,
    ExtensionArtifactTarget,
    ExtensionArtifactTransferInput,
    ExtensionArtifactTransferRecord,
    ExtensionArtifactTransferResult,
} from "@portable-devshell/extension/artifact";
import type {
    ArtifactShareInput,
    ArtifactShareResult,
    ArtifactSourceDescriptor,
    ArtifactTargetDescriptor,
    ArtifactTransferRecord,
    ArtifactTransferResult,
    ArtifactTransferStartInput,
} from "@portable-devshell/shared";
import type { ArtifactService } from "../../../artifact/Service.js";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
    ExtensionAssetBundle,
    ExtensionAssetCapability,
    ExtensionAssetProjectionInput,
    ExtensionAssetProjectionResult,
} from "@portable-devshell/extension";
import {
    createArtifactDirectoryArchive,
    extractArtifactDirectoryArchive,
} from "../../../artifact/host/storage/Archive.js";
import { resolveExtensionInstallLimits } from "../../install/Policy.js";
import type { ExtensionInstallLimits } from "../../install/Policy.js";

export interface ExtensionArtifactCapabilityControlOptions {
    allowed: boolean;
    extensionId: string;
    service: Pick<
        ArtifactService,
        | "cancelTransfer"
        | "createShare"
        | "getTransfer"
        | "listShares"
        | "listTransfers"
        | "revokeShare"
        | "startTransfer"
        | "waitForTransfer"
    >;
}

/** Public Artifact management capability backed by the Control-owned Artifact domain. */
export class ExtensionArtifactCapabilityControl implements ExtensionArtifactCapability {
    readonly #allowed: boolean;
    readonly #extensionId: string;
    readonly #service: ExtensionArtifactCapabilityControlOptions["service"];

    constructor(options: ExtensionArtifactCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#service = options.service;
    }

    async createShare(
        input: ExtensionArtifactShareInput,
    ): Promise<ExtensionArtifactShareRecord> {
        this.#assertAllowed();
        const source = toShareInput(input);
        return toShareRecord(
            await this.#service.createShare(source, input.authorityInstance),
        );
    }

    async listShares(): Promise<readonly ExtensionArtifactShareRecord[]> {
        this.#assertAllowed();
        return this.#service.listShares().map(toShareRecord);
    }

    async revokeShare(
        shareId: string,
    ): Promise<ExtensionArtifactShareRevokeResult> {
        this.#assertAllowed();
        return await this.#service.revokeShare(requireText(shareId, "shareId"));
    }

    async startTransfer(
        input: ExtensionArtifactTransferInput,
    ): Promise<ExtensionArtifactTransferResult> {
        this.#assertAllowed();
        return toTransferResult(
            await this.#service.startTransfer(
                toTransferStartInput(input),
                input.authorityInstance,
            ),
        );
    }

    async getTransfer(
        transferId: string,
    ): Promise<ExtensionArtifactTransferRecord> {
        this.#assertAllowed();
        return toTransferRecord(
            this.#service.getTransfer(requireText(transferId, "transferId")),
        );
    }

    async listTransfers(): Promise<readonly ExtensionArtifactTransferRecord[]> {
        this.#assertAllowed();
        return this.#service.listTransfers().map(toTransferRecord);
    }

    async cancelTransfer(
        transferId: string,
    ): Promise<ExtensionArtifactTransferResult> {
        this.#assertAllowed();
        return toTransferResult(
            await this.#service.cancelTransfer(
                requireText(transferId, "transferId"),
            ),
        );
    }

    async waitForTransfer(
        transferId: string,
    ): Promise<ExtensionArtifactTransferRecord> {
        this.#assertAllowed();
        return toTransferRecord(
            await this.#service.waitForTransfer(
                requireText(transferId, "transferId"),
            ),
        );
    }

    #assertAllowed(): void {
        if (this.#allowed) return;
        throw new Error(
            `Extension ${this.#extensionId} did not declare the artifacts capability.`,
        );
    }
}

function toShareInput(input: ExtensionArtifactShareInput): ArtifactShareInput {
    const source = input.source;
    return source.handle !== undefined
        ? {
              ...(input.expiresInSeconds === undefined
                  ? {}
                  : { expiresInSeconds: input.expiresInSeconds }),
              handle: requireText(source.handle, "source.handle"),
              instance: requireText(source.instance, "source.instance"),
              ...(input.maxDownloads === undefined
                  ? {}
                  : { maxDownloads: input.maxDownloads }),
          }
        : {
              ...(input.expiresInSeconds === undefined
                  ? {}
                  : { expiresInSeconds: input.expiresInSeconds }),
              instance: requireText(source.instance, "source.instance"),
              ...(input.maxDownloads === undefined
                  ? {}
                  : { maxDownloads: input.maxDownloads }),
              path: requireText(source.path, "source.path"),
              workspace: requireText(source.workspace, "source.workspace"),
          };
}

function toTransferStartInput(
    input: ExtensionArtifactTransferInput,
): ArtifactTransferStartInput {
    const common = {
        instance: requireText(input.source.instance, "source.instance"),
        operation: "start" as const,
        ...(input.overwrite === undefined
            ? {}
            : { overwrite: input.overwrite }),
        targetInstance: requireText(input.target.instance, "target.instance"),
        targetPath: requireText(input.target.path, "target.path"),
        targetWorkspace: requireText(
            input.target.workspace,
            "target.workspace",
        ),
    };
    return input.source.handle !== undefined
        ? {
              ...common,
              handle: requireText(input.source.handle, "source.handle"),
          }
        : {
              ...common,
              sourcePath: requireText(input.source.path, "source.path"),
              sourceWorkspace: requireText(
                  input.source.workspace,
                  "source.workspace",
              ),
          };
}

function toShareRecord(
    value: ArtifactShareResult,
): ExtensionArtifactShareRecord {
    return {
        blake3: value.blake3,
        bytes: value.bytes,
        ...(value.downloadCount === undefined
            ? {}
            : { downloadCount: value.downloadCount }),
        downloadName: value.downloadName,
        expiresAtMs: value.expiresAtMs,
        ...(value.maxDownloads === undefined
            ? {}
            : { maxDownloads: value.maxDownloads }),
        mediaType: value.mediaType,
        shareId: value.shareId,
        source: toSource(value.source),
        state: value.state,
        url: value.url,
    };
}

function toTransferResult(
    value: ArtifactTransferResult,
): ExtensionArtifactTransferResult {
    return {
        operation: value.operation,
        transfer: toTransferRecord(value.transfer),
    };
}

function toTransferRecord(
    value: ArtifactTransferRecord,
): ExtensionArtifactTransferRecord {
    return {
        ...(value.completedAt === undefined
            ? {}
            : { completedAt: value.completedAt }),
        createdAt: value.createdAt,
        ...(value.failure === undefined
            ? {}
            : { failure: { ...value.failure } }),
        ...(value.payload === undefined
            ? {}
            : { payload: { ...value.payload } }),
        source: toSource(value.source),
        ...(value.startedAt === undefined
            ? {}
            : { startedAt: value.startedAt }),
        status: value.status,
        target: toTarget(value.target),
        ...(value.totalBytes === undefined
            ? {}
            : { totalBytes: value.totalBytes }),
        transferId: value.transferId,
        transferredBytes: value.transferredBytes,
        updatedAt: value.updatedAt,
    };
}

function toSource(value: ArtifactSourceDescriptor): ExtensionArtifactSource {
    if (value.handle !== undefined) {
        return { handle: value.handle, instance: value.instance };
    }
    if (value.path !== undefined && value.workspace !== undefined) {
        return {
            instance: value.instance,
            path: value.path,
            workspace: value.workspace,
        };
    }
    throw new Error(
        "Artifact source record is missing its handle or path/workspace identity.",
    );
}

function toTarget(value: ArtifactTargetDescriptor): ExtensionArtifactTarget {
    if (value.workspace === undefined) {
        throw new Error(
            "Artifact target record is missing its workspace identity.",
        );
    }
    return {
        instance: value.instance,
        path: value.path,
        workspace: value.workspace,
    };
}

function requireText(value: string, field: string): string {
    if (value.trim().length > 0) return value;
    throw new TypeError(
        `Extension artifacts ${field} must be a non-empty string.`,
    );
}

export interface ExtensionAssetProjectionPortInput {
    overwrite?: boolean;
    signal?: AbortSignal;
    sourcePath: string;
    target: ExtensionAssetProjectionInput["target"];
}

export type ExtensionAssetProjectionPort = (
    input: ExtensionAssetProjectionPortInput,
) => Promise<ExtensionAssetProjectionResult>;

export interface ExtensionAssetCapabilityControlOptions {
    allowed: boolean;
    dataDirectory: string;
    extensionId: string;
    limits?: Partial<ExtensionInstallLimits>;
    project?: ExtensionAssetProjectionPort;
}

export class ExtensionAssetCapabilityControl implements ExtensionAssetCapability {
    readonly #allowed: boolean;
    readonly #dataDirectory: string;
    readonly #extensionId: string;
    readonly #limits: ExtensionInstallLimits;
    readonly #project?: ExtensionAssetProjectionPort;

    constructor(options: ExtensionAssetCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#dataDirectory = options.dataDirectory;
        this.#extensionId = options.extensionId;
        this.#limits = resolveExtensionInstallLimits(options.limits);
        this.#project = options.project;
    }

    async installBundle(sourcePath: string): Promise<ExtensionAssetBundle> {
        this.#assertAllowed();
        if (!isAbsolute(sourcePath)) {
            throw new TypeError(
                "Extension asset bundle source must be an absolute local path.",
            );
        }
        const source = await lstat(sourcePath).catch((error: unknown) => {
            throw new Error("Extension asset bundle source is unavailable.", {
                cause: error,
            });
        });
        if (source.isSymbolicLink() || !source.isFile()) {
            throw new TypeError(
                "Extension asset bundle source must be a regular file, not a symlink.",
            );
        }
        if (source.size > this.#limits.maxCompressedBytes) {
            throw new TypeError(
                "Extension asset bundle exceeds the compressed byte limit.",
            );
        }

        const bundleRoot = this.#bundleRoot();
        const transactionId = randomUUID();
        const snapshot = join(
            this.#dataDirectory,
            `.asset-source-${transactionId}.bundle`,
        );
        await mkdir(bundleRoot, { mode: 0o700, recursive: true });
        await assertPlainDirectory(bundleRoot, "Extension asset bundle root");

        try {
            const digest = await snapshotPlainFile(
                sourcePath,
                source.size,
                snapshot,
            );
            const generation = `sha256-${digest}`;
            const destination = join(bundleRoot, generation);
            const staging = join(
                this.#dataDirectory,
                `.asset-staging-${transactionId}`,
            );
            await mkdir(staging, { mode: 0o700 });
            try {
                await extractArtifactDirectoryArchive(
                    snapshot,
                    staging,
                    this.#limits,
                );
                const existing = await lstat(destination).catch(
                    (error: unknown) => {
                        if (isMissing(error)) return undefined;
                        throw error;
                    },
                );
                if (existing === undefined) {
                    try {
                        await rename(staging, destination);
                    } catch (error) {
                        if (!isAlreadyExists(error)) throw error;
                        await assertPlainDirectory(
                            destination,
                            `Extension asset bundle ${generation}`,
                        );
                    }
                } else if (
                    existing.isSymbolicLink() ||
                    !existing.isDirectory()
                ) {
                    throw new TypeError(
                        `Extension asset bundle generation is not a plain directory: ${generation}.`,
                    );
                }
                return Object.freeze({ directory: destination, generation });
            } finally {
                await rm(staging, { force: true, recursive: true }).catch(
                    () => undefined,
                );
            }
        } finally {
            await rm(snapshot, { force: true }).catch(() => undefined);
        }
    }

    async installDirectory(sourcePath: string): Promise<ExtensionAssetBundle> {
        this.#assertAllowed();
        if (!isAbsolute(sourcePath)) {
            throw new TypeError(
                "Extension asset directory source must be an absolute local path.",
            );
        }
        const source = await lstat(sourcePath).catch((error: unknown) => {
            throw new Error(
                "Extension asset directory source is unavailable.",
                { cause: error },
            );
        });
        if (source.isSymbolicLink() || !source.isDirectory()) {
            throw new TypeError(
                "Extension asset directory source must be a plain directory, not a symlink.",
            );
        }
        await mkdir(this.#dataDirectory, { mode: 0o700, recursive: true });
        const archive = join(
            this.#dataDirectory,
            `.asset-source-${randomUUID()}.tar.zst`,
        );
        try {
            await createArtifactDirectoryArchive(sourcePath, archive);
            return await this.installBundle(archive);
        } finally {
            await rm(archive, { force: true }).catch(() => undefined);
        }
    }

    async listBundles(): Promise<readonly ExtensionAssetBundle[]> {
        this.#assertAllowed();
        const root = this.#bundleRoot();
        const entries = await readdir(root, { withFileTypes: true }).catch(
            (error: unknown) => {
                if (isMissing(error)) return [];
                throw error;
            },
        );
        const bundles: ExtensionAssetBundle[] = [];
        for (const entry of entries.sort((left, right) =>
            left.name.localeCompare(right.name),
        )) {
            if (!isBundleGeneration(entry.name)) continue;
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                throw new TypeError(
                    `Extension asset bundle generation is not a plain directory: ${entry.name}.`,
                );
            }
            bundles.push(
                Object.freeze({
                    directory: join(root, entry.name),
                    generation: entry.name,
                }),
            );
        }
        return Object.freeze(bundles);
    }

    async resolveBundle(
        generation: string,
    ): Promise<ExtensionAssetBundle | undefined> {
        this.#assertAllowed();
        assertBundleGeneration(generation);
        const directory = join(this.#bundleRoot(), generation);
        const metadata = await lstat(directory).catch((error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
        });
        if (metadata === undefined) return undefined;
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new TypeError(
                `Extension asset bundle generation is not a plain directory: ${generation}.`,
            );
        }
        return Object.freeze({ directory, generation });
    }

    async removeBundle(generation: string): Promise<void> {
        this.#assertAllowed();
        const bundle = await this.resolveBundle(generation);
        if (bundle === undefined) return;
        await rm(bundle.directory, { force: true, recursive: true });
    }

    async projectBundle(
        input: ExtensionAssetProjectionInput,
    ): Promise<ExtensionAssetProjectionResult> {
        this.#assertAllowed();
        input.signal?.throwIfAborted();
        const bundle = await this.resolveBundle(input.generation);
        if (bundle === undefined) {
            throw new Error(
                `Extension asset bundle ${input.generation} is not installed.`,
            );
        }
        validateProjectionTarget(input.target);
        if (this.#project === undefined) {
            throw new Error(
                `Extension ${this.#extensionId} asset projection is unavailable.`,
            );
        }
        return await this.#project({
            ...(input.overwrite === undefined
                ? {}
                : { overwrite: input.overwrite }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            sourcePath: bundle.directory,
            target: { ...input.target },
        });
    }

    #assertAllowed(): void {
        if (!this.#allowed) {
            throw new Error(
                `Extension ${this.#extensionId} did not declare the assets capability.`,
            );
        }
    }

    #bundleRoot(): string {
        return join(this.#dataDirectory, "bundles");
    }
}

function validateProjectionTarget(
    target: ExtensionAssetProjectionInput["target"],
): void {
    if (target.instance.length === 0)
        throw new TypeError(
            "Extension asset projection target instance must not be empty.",
        );
    if (!/^[a-z][a-z0-9-]*$/u.test(target.collection)) {
        throw new TypeError(
            "Extension asset projection resource collection must match [a-z][a-z0-9-]*.",
        );
    }
    if (
        target.key.length === 0 ||
        target.key !== target.key.trim() ||
        target.key === "." ||
        target.key === ".." ||
        /[\\/]/u.test(target.key)
    ) {
        throw new TypeError(
            "Extension asset projection resource key must be one non-empty path segment.",
        );
    }
}

async function snapshotPlainFile(
    path: string,
    expectedSize: number,
    snapshotPath: string,
): Promise<string> {
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const snapshot = await open(
            snapshotPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
        );
        try {
            const current = await source.stat();
            if (!current.isFile() || current.size !== expectedSize) {
                throw new Error(
                    "Extension asset bundle changed while being read.",
                );
            }
            const hash = createHash("sha256");
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let position = 0;
            while (position < current.size) {
                const requested = Math.min(
                    buffer.length,
                    current.size - position,
                );
                const { bytesRead } = await source.read(
                    buffer,
                    0,
                    requested,
                    position,
                );
                if (bytesRead <= 0)
                    throw new Error(
                        "Extension asset bundle changed while being read.",
                    );
                hash.update(buffer.subarray(0, bytesRead));
                let written = 0;
                while (written < bytesRead) {
                    const result = await snapshot.write(
                        buffer,
                        written,
                        bytesRead - written,
                        position + written,
                    );
                    if (result.bytesWritten <= 0)
                        throw new Error(
                            "Extension asset snapshot write made no progress.",
                        );
                    written += result.bytesWritten;
                }
                position += bytesRead;
            }
            await snapshot.sync();
            return hash.digest("hex");
        } finally {
            await snapshot.close();
        }
    } finally {
        await source.close();
    }
}

function assertBundleGeneration(value: string): void {
    if (!isBundleGeneration(value)) {
        throw new TypeError(
            `Invalid Extension asset bundle generation: ${value}.`,
        );
    }
}

function isBundleGeneration(value: string): boolean {
    return /^sha256-[0-9a-f]{64}$/u.test(value);
}

async function assertPlainDirectory(
    path: string,
    label: string,
): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TypeError(`${label} must be a plain directory.`);
    }
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

function isAlreadyExists(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error))
        return false;
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EEXIST" || code === "ENOTEMPTY";
}
