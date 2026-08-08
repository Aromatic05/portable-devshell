import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { resolve } from "node:path";

import { createError, errorCodes } from "@portable-devshell/shared";

import type { WorkerAsset } from "../WorkerAssetResolver.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";
import { workerBinaryFileName, workerInstalledAliasFileName } from "../target/WorkerTargetBinary.js";

export interface WorkerInstallerLocalResult {
    executablePath: string;
    sha256: string;
}

interface InstallLayout {
    aliasPath: string;
    binDir: string;
    binaryName: string;
    binaryPath: string;
    installDir: string;
    shaPath: string;
}

export interface WorkerInstallerLocalFileSystem {
    chmod: typeof nodeFs.chmod;
    copyFile: typeof nodeFs.copyFile;
    mkdir: typeof nodeFs.mkdir;
    readFile: typeof nodeFs.readFile;
    rename: typeof nodeFs.rename;
    rm: typeof nodeFs.rm;
    symlink: typeof nodeFs.symlink;
    writeFile: typeof nodeFs.writeFile;
}

export class WorkerInstallerLocal {
    readonly #fs: WorkerInstallerLocalFileSystem;

    constructor(options: { fileSystem?: Partial<WorkerInstallerLocalFileSystem> } = {}) {
        this.#fs = {
            chmod: nodeFs.chmod,
            copyFile: nodeFs.copyFile,
            mkdir: nodeFs.mkdir,
            readFile: nodeFs.readFile,
            rename: nodeFs.rename,
            rm: nodeFs.rm,
            symlink: nodeFs.symlink,
            writeFile: nodeFs.writeFile,
            ...options.fileSystem,
        };
    }

    async ensure(devshellHomeDirectory: string, asset: WorkerAsset, target: WorkerTarget): Promise<string> {
        return (await this.ensureInstalled(devshellHomeDirectory, asset, target)).executablePath;
    }

    async ensureInstalled(
        devshellHomeDirectory: string,
        asset: WorkerAsset,
        target: WorkerTarget
    ): Promise<WorkerInstallerLocalResult> {
        if (asset.target.key !== target.key) {
            throw createError({
                code: errorCodes.coreWorkerProvisionFailed,
                details: { assetTargetKey: asset.target.key, targetKey: target.key },
                message: "Resolved worker asset target does not match install target.",
                retryable: false
            });
        }

        const source = await this.#fs.readFile(asset.binaryPath);
        const actualSourceSha = createHash("sha256").update(source).digest("hex");
        if (actualSourceSha !== asset.sha256) {
            throw createError({
                code: errorCodes.coreWorkerProvisionFailed,
                details: {
                    actualSha256: actualSourceSha,
                    expectedSha256: asset.sha256,
                    source: asset.binaryPath,
                },
                message: "Resolved worker bundle checksum does not match its manifest.",
                retryable: false,
            });
        }

        const layout = installLayout(devshellHomeDirectory, asset, target);
        await this.#fs.mkdir(layout.installDir, target.os === "windows" ? { recursive: true } : { recursive: true, mode: 0o700 });
        await this.#fs.mkdir(layout.binDir, target.os === "windows" ? { recursive: true } : { recursive: true, mode: 0o700 });

        if (await readInstalledSha(this.#fs, layout.binaryPath, layout.shaPath) !== asset.sha256) {
            await this.#installAsset(layout, source, asset.sha256, target.os === "windows");
        }
        if (await readInstalledSha(this.#fs, layout.binaryPath, layout.shaPath) !== asset.sha256) {
            throw createError({
                code: errorCodes.coreWorkerProvisionFailed,
                details: { binaryPath: layout.binaryPath, expectedSha256: asset.sha256 },
                message: "Installed worker bundle failed verification.",
                retryable: true,
            });
        }

        return target.os === "windows"
            ? await this.#finishWindows(layout, asset)
            : await this.#finishUnix(layout, asset, target);
    }

    async #installAsset(
        layout: InstallLayout,
        bytes: Buffer,
        sha256: string,
        windows: boolean,
    ): Promise<void> {
        const suffix = `.tmp-${process.pid}-${randomUUID()}`;
        const tmpBinaryPath = `${layout.binaryPath}${suffix}`;
        const tmpShaPath = `${layout.shaPath}${suffix}`;
        try {
            await this.#fs.writeFile(tmpBinaryPath, bytes, windows ? undefined : { mode: 0o755 });
            if (!windows) await this.#fs.chmod(tmpBinaryPath, 0o755);
            await this.#fs.writeFile(tmpShaPath, `${sha256}\n`, windows ? "utf8" : { mode: 0o600 });
            await this.#replaceFile(tmpBinaryPath, layout.binaryPath);
            await this.#replaceFile(tmpShaPath, layout.shaPath);
        } finally {
            await Promise.all([
                this.#fs.rm(tmpBinaryPath, { force: true }).catch(() => undefined),
                this.#fs.rm(tmpShaPath, { force: true }).catch(() => undefined),
            ]);
        }
    }

    async #finishWindows(layout: InstallLayout, asset: WorkerAsset): Promise<WorkerInstallerLocalResult> {
        const stagedAlias = `${layout.aliasPath}.next-${randomUUID()}`;
        try {
            await this.#fs.copyFile(layout.binaryPath, stagedAlias);
            await this.#replaceFile(stagedAlias, layout.aliasPath);
        } finally {
            await this.#fs.rm(stagedAlias, { force: true }).catch(() => undefined);
        }
        return { executablePath: layout.binaryPath, sha256: asset.sha256 };
    }

    async #finishUnix(layout: InstallLayout, asset: WorkerAsset, target: WorkerTarget): Promise<WorkerInstallerLocalResult> {
        const defaultAliasPath = resolve(layout.binDir, "devshell-worker");
        // The stable default alias points at the target-specific alias. Ensure it
        // exists before switching the target-specific alias so a failed switch
        // cannot strand the previous active worker.
        await refreshSymlink(
            this.#fs,
            defaultAliasPath,
            workerInstalledAliasFileName(target),
        );
        await refreshSymlink(
            this.#fs,
            layout.aliasPath,
            `../workers/${target.key}/${asset.sha256}/${layout.binaryName}`,
        );
        return { executablePath: layout.binaryPath, sha256: asset.sha256 };
    }

    async #replaceFile(source: string, destination: string): Promise<void> {
        await this.#fs.rename(source, destination);
    }
}

function installLayout(devshellHomeDirectory: string, asset: WorkerAsset, target: WorkerTarget): InstallLayout {
    const binaryName = workerBinaryFileName(target);
    const installDir = resolve(devshellHomeDirectory, "workers", target.key, asset.sha256);
    const binDir = resolve(devshellHomeDirectory, "bin");
    return {
        aliasPath: resolve(binDir, workerInstalledAliasFileName(target)),
        binDir,
        binaryName,
        binaryPath: resolve(installDir, binaryName),
        installDir,
        shaPath: resolve(installDir, `${binaryName}.sha256`)
    };
}

async function readInstalledSha(
    fs: WorkerInstallerLocalFileSystem,
    binaryPath: string,
    shaPath: string,
): Promise<string | undefined> {
    try {
        const [binary, sha] = await Promise.all([
            fs.readFile(binaryPath),
            fs.readFile(shaPath, "utf8"),
        ]);
        const actual = createHash("sha256").update(binary).digest("hex");
        return actual === sha.trim() ? actual : undefined;
    } catch {
        return undefined;
    }
}

async function refreshSymlink(
    fs: WorkerInstallerLocalFileSystem,
    path: string,
    target: string,
): Promise<void> {
    const staged = `${path}.next-${randomUUID()}`;
    try {
        await fs.symlink(target, staged);
        await fs.rename(staged, path);
    } finally {
        await fs.rm(staged, { force: true }).catch(() => undefined);
    }
}
