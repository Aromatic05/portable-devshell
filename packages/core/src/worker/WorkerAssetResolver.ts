import { accessSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerAsset {
    binaryPath: string;
    sha256: string;
}

const bundledWorkerRelativePath = "../../assets/devshell-worker";

export class WorkerAssetResolver {
    readonly #moduleDir: string;

    constructor(moduleUrl: string = import.meta.url) {
        this.#moduleDir = dirname(fileURLToPath(moduleUrl));
    }

    async resolve(): Promise<WorkerAsset> {
        const checkedPaths: string[] = [];

        for (const binaryPath of this.#candidatePaths()) {
            checkedPaths.push(binaryPath);

            if (!isReadableFile(binaryPath)) {
                continue;
            }

            return {
                binaryPath,
                sha256: createHash("sha256").update(await readFile(binaryPath)).digest("hex")
            };
        }

        throw new Error(`worker binary could not be resolved; checked: ${checkedPaths.join(", ")}`);
    }

    *#candidatePaths(): Iterable<string> {
        const envPath = process.env.PORTABLE_DEVSHELL_WORKER_PATH;

        if (envPath !== undefined && envPath.length > 0) {
            yield envPath;
        }

        yield resolve(this.#moduleDir, bundledWorkerRelativePath);

        let probeDir = this.#moduleDir;
        for (let depth = 0; depth < 6; depth += 1) {
            yield resolve(probeDir, "target/debug/devshell-worker");
            yield resolve(probeDir, "target/release/devshell-worker");
            probeDir = resolve(probeDir, "..");
        }
    }
}

function isReadableFile(path: string): boolean {
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}
