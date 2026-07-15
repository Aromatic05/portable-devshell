import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createError, errorCodes } from "@portable-devshell/shared";

import type { WorkerAsset } from "../WorkerAssetResolver.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";
import { workerBinaryFileName, workerInstalledAliasFileName } from "../target/WorkerTargetBinary.js";

export interface LocalWorkerInstallResult {
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

export class LocalWorkerInstaller {
    async ensure(devshellHomeDirectory: string, asset: WorkerAsset, target: WorkerTarget): Promise<string> {
        return (await this.ensureInstalled(devshellHomeDirectory, asset, target)).executablePath;
    }

    async ensureInstalled(
        devshellHomeDirectory: string,
        asset: WorkerAsset,
        target: WorkerTarget
    ): Promise<LocalWorkerInstallResult> {
        if (asset.target.key !== target.key) {
            throw createError({
                code: errorCodes.coreWorkerProvisionFailed,
                details: { assetTargetKey: asset.target.key, targetKey: target.key },
                message: "Resolved worker asset target does not match install target.",
                retryable: false
            });
        }

        const layout = installLayout(devshellHomeDirectory, asset, target);
        await mkdir(layout.installDir, target.os === "windows" ? { recursive: true } : { recursive: true, mode: 0o700 });
        await mkdir(layout.binDir, target.os === "windows" ? { recursive: true } : { recursive: true, mode: 0o700 });

        if (await readInstalledSha(layout.binaryPath, layout.shaPath) !== asset.sha256) {
            await this.#installAsset(layout, asset, target.os === "windows");
        }

        return target.os === "windows"
            ? await this.#finishWindows(layout, asset)
            : await this.#finishUnix(layout, asset, target);
    }

    async #installAsset(layout: InstallLayout, asset: WorkerAsset, windows: boolean): Promise<void> {
        const suffix = windows ? `.tmp-${process.pid}` : ".tmp";
        const tmpBinaryPath = `${layout.binaryPath}${suffix}`;
        const tmpShaPath = `${layout.shaPath}${suffix}`;
        const bytes = await readFile(asset.binaryPath);
        await writeFile(tmpBinaryPath, bytes, windows ? undefined : { mode: 0o755 });
        if (!windows) {
            await chmod(tmpBinaryPath, 0o755);
        }
        await writeFile(tmpShaPath, `${asset.sha256}\n`, windows ? "utf8" : { mode: 0o600 });
        await rename(tmpBinaryPath, layout.binaryPath);
        await rename(tmpShaPath, layout.shaPath);
    }

    async #finishWindows(layout: InstallLayout, asset: WorkerAsset): Promise<LocalWorkerInstallResult> {
        await copyFile(layout.binaryPath, layout.aliasPath);
        return { executablePath: layout.binaryPath, sha256: asset.sha256 };
    }

    async #finishUnix(layout: InstallLayout, asset: WorkerAsset, target: WorkerTarget): Promise<LocalWorkerInstallResult> {
        const defaultAliasPath = resolve(layout.binDir, "devshell-worker");
        await refreshSymlink(layout.aliasPath, `../workers/${target.key}/${asset.sha256}/${layout.binaryName}`);
        await refreshSymlink(defaultAliasPath, workerInstalledAliasFileName(target));
        return { executablePath: defaultAliasPath, sha256: asset.sha256 };
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

async function readInstalledSha(binaryPath: string, shaPath: string): Promise<string | undefined> {
    try {
        const [binary, sha] = await Promise.all([readFile(binaryPath), readFile(shaPath, "utf8")]);
        const actual = createHash("sha256").update(binary).digest("hex");
        return actual === sha.trim() ? actual : undefined;
    } catch {
        return undefined;
    }
}

async function refreshSymlink(path: string, target: string): Promise<void> {
    await rm(path, { force: true });
    await symlink(target, path);
}
