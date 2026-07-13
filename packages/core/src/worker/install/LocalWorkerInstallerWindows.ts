import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkerAsset } from "../WorkerAssetResolver.js";
import type { WorkerTarget } from "../target/WorkerTarget.js";
import { workerBinaryFileName } from "../target/WorkerTargetBinary.js";

export class LocalWorkerInstallerWindows {
    async ensure(homeDirectory: string, asset: WorkerAsset, target: WorkerTarget): Promise<string> {
        const binaryName = workerBinaryFileName(target);
        const installDir = resolve(homeDirectory, ".devshell", "workers", target.key, asset.sha256);
        const binaryPath = resolve(installDir, binaryName);
        const shaPath = resolve(installDir, `${binaryName}.sha256`);

        await mkdir(installDir, { recursive: true });

        if ((await readInstalledSha(binaryPath, shaPath)) !== asset.sha256) {
            const bytes = await readFile(asset.binaryPath);
            const tmpBinaryPath = `${binaryPath}.tmp-${process.pid}`;
            const tmpShaPath = `${shaPath}.tmp-${process.pid}`;
            await writeFile(tmpBinaryPath, bytes);
            await writeFile(tmpShaPath, `${asset.sha256}\n`, "utf8");
            await rename(tmpBinaryPath, binaryPath);
            await rename(tmpShaPath, shaPath);
        }

        return binaryPath;
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
