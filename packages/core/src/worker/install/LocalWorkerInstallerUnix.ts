import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkerAsset } from "../WorkerAssetResolver.js";
import type { LocalWorkerInstallResult } from "./LocalWorkerInstaller.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";
import { workerBinaryFileName, workerInstalledAliasFileName } from "../target/WorkerTargetBinary.js";

export class LocalWorkerInstallerUnix {
    async ensureInstalled(
        devshellHomeDirectory: string,
        asset: WorkerAsset,
        target: WorkerTarget
    ): Promise<LocalWorkerInstallResult> {
        const binaryName = workerBinaryFileName(target);
        const installDir = resolve(devshellHomeDirectory, "workers", target.key, asset.sha256);
        const binDir = resolve(devshellHomeDirectory, "bin");
        const binaryPath = resolve(installDir, binaryName);
        const shaPath = resolve(installDir, `${binaryName}.sha256`);
        const targetSymlinkPath = resolve(binDir, workerInstalledAliasFileName(target));
        const symlinkPath = resolve(binDir, "devshell-worker");
        const targetSymlink = `../workers/${target.key}/${asset.sha256}/${binaryName}`;
        const installedSha = await readInstalledSha(binaryPath, shaPath);

        await mkdir(installDir, { recursive: true, mode: 0o700 });
        await mkdir(binDir, { recursive: true, mode: 0o700 });

        if (installedSha !== asset.sha256) {
            const tmpBinaryPath = `${binaryPath}.tmp`;
            const tmpShaPath = `${shaPath}.tmp`;
            const bytes = await readFile(asset.binaryPath);

            await writeFile(tmpBinaryPath, bytes, { mode: 0o755 });
            await chmod(tmpBinaryPath, 0o755);
            await writeFile(tmpShaPath, `${asset.sha256}\n`, { mode: 0o600 });
            await rename(tmpBinaryPath, binaryPath);
            await rename(tmpShaPath, shaPath);
        }

        await this.#refreshSymlink(targetSymlinkPath, targetSymlink);
        await this.#refreshSymlink(symlinkPath, workerInstalledAliasFileName(target));
        return { executablePath: symlinkPath, sha256: asset.sha256 };
    }

    async #refreshSymlink(symlinkPath: string, target: string): Promise<void> {
        await rm(symlinkPath, { force: true });
        await symlink(target, symlinkPath);
    }
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
