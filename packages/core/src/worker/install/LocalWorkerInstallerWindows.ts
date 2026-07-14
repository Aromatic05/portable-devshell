import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkerAsset } from "../WorkerAssetResolver.js";
import type { LocalWorkerInstallResult } from "./LocalWorkerInstaller.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";
import { workerBinaryFileName, workerInstalledAliasFileName } from "../target/WorkerTargetBinary.js";

export class LocalWorkerInstallerWindows {
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
        const aliasPath = resolve(binDir, workerInstalledAliasFileName(target));

        await mkdir(installDir, { recursive: true });
        await mkdir(binDir, { recursive: true });

        const installedSha = await readInstalledSha(binaryPath, shaPath);
        if (installedSha !== asset.sha256) {
            const bytes = await readFile(asset.binaryPath);
            const tmpBinaryPath = `${binaryPath}.tmp-${process.pid}`;
            const tmpShaPath = `${shaPath}.tmp-${process.pid}`;
            await writeFile(tmpBinaryPath, bytes);
            await writeFile(tmpShaPath, `${asset.sha256}\n`, "utf8");
            await rename(tmpBinaryPath, binaryPath);
            await rename(tmpShaPath, shaPath);
        }

        await copyFile(binaryPath, aliasPath);

        return { executablePath: binaryPath, sha256: asset.sha256 };
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
