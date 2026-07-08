import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkerAsset } from "../WorkerAssetResolver.js";

export class LocalWorkerInstaller {
    async ensure(homeDirectory: string, asset: WorkerAsset): Promise<string> {
        const targetTriple = detectTargetTriple();
        const installDir = resolve(homeDirectory, ".devshell", "workers", targetTriple, asset.sha256);
        const binDir = resolve(homeDirectory, ".devshell", "bin");
        const binaryPath = resolve(installDir, "devshell-worker");
        const shaPath = resolve(installDir, "devshell-worker.sha256");
        const symlinkPath = resolve(binDir, "devshell-worker");

        await mkdir(installDir, { recursive: true, mode: 0o700 });
        await mkdir(binDir, { recursive: true, mode: 0o700 });

        const installedSha = await readInstalledSha(binaryPath, shaPath);
        if (installedSha === asset.sha256) {
            await this.#refreshSymlink(symlinkPath, targetTriple, asset.sha256);
            return symlinkPath;
        }

        const tmpBinaryPath = `${binaryPath}.tmp`;
        const tmpShaPath = `${shaPath}.tmp`;
        const bytes = await readFile(asset.binaryPath);

        await writeFile(tmpBinaryPath, bytes, { mode: 0o755 });
        await chmod(tmpBinaryPath, 0o755);
        await writeFile(tmpShaPath, `${asset.sha256}\n`, { mode: 0o600 });
        await rename(tmpBinaryPath, binaryPath);
        await rename(tmpShaPath, shaPath);
        await this.#refreshSymlink(symlinkPath, targetTriple, asset.sha256);

        return symlinkPath;
    }

    async #refreshSymlink(symlinkPath: string, targetTriple: string, sha256: string): Promise<void> {
        await rm(symlinkPath, { force: true });
        await symlink(`../workers/${targetTriple}/${sha256}/devshell-worker`, symlinkPath);
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

function detectTargetTriple(): string {
    const arch =
        process.arch === "x64"
            ? "x86_64"
            : process.arch === "arm64"
              ? "aarch64"
              : process.arch;

    return `${process.platform}-${arch}`;
}
