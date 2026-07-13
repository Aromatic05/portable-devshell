import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkerAsset } from "../WorkerAssetResolver.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";
import { workerBinaryFileName } from "../target/WorkerTargetBinary.js";

export class LocalWorkerInstallerUnix {
    async ensure(homeDirectory: string, asset: WorkerAsset, target: WorkerTarget): Promise<string> {
        const binaryName = workerBinaryFileName(target);
        const installDir = resolve(homeDirectory, ".devshell", "workers", target.key, asset.sha256);
        const binDir = resolve(homeDirectory, ".devshell", "bin");
        const binaryPath = resolve(installDir, binaryName);
        const shaPath = resolve(installDir, `${binaryName}.sha256`);
        const symlinkPath = resolve(binDir, "devshell-worker");

        await mkdir(installDir, { recursive: true, mode: 0o700 });
        await mkdir(binDir, { recursive: true, mode: 0o700 });

        const installedSha = await readInstalledSha(binaryPath, shaPath);
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

        await this.#refreshSymlink(symlinkPath, target.key, asset.sha256, binaryName);
        return symlinkPath;
    }

    async #refreshSymlink(symlinkPath: string, targetKey: string, sha256: string, binaryName: string): Promise<void> {
        await rm(symlinkPath, { force: true });
        await symlink(`../workers/${targetKey}/${sha256}/${binaryName}`, symlinkPath);
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
