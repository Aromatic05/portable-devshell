import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    ARTIFACT_RECORD_VERSION,
    type StoredArtifactShare,
    type StoredArtifactTransfer
} from "./ArtifactServiceModel.js";

export class ArtifactRecordStore {
    readonly #sharesDir: string;
    readonly #storageDir: string;
    readonly #transfersDir: string;

    constructor(storageDir: string) {
        this.#storageDir = storageDir;
        this.#sharesDir = join(storageDir, "shares");
        this.#transfersDir = join(storageDir, "transfers");
    }

    async initialize(): Promise<void> {
        await mkdir(this.#sharesDir, { mode: 0o700, recursive: true });
        await mkdir(this.#transfersDir, { mode: 0o700, recursive: true });
        await chmod(this.#storageDir, 0o700).catch(() => undefined);
        await chmod(this.#sharesDir, 0o700).catch(() => undefined);
        await chmod(this.#transfersDir, 0o700).catch(() => undefined);
    }

    async loadShares(): Promise<StoredArtifactShare[]> {
        const shares: StoredArtifactShare[] = [];
        for (const file of await listJsonFiles(this.#sharesDir)) {
            const stored = await readJsonFile<StoredArtifactShare>(join(this.#sharesDir, file));
            if (stored !== undefined && stored.version === ARTIFACT_RECORD_VERSION) {
                shares.push(stored);
            }
        }
        return shares;
    }

    async loadTransfers(): Promise<StoredArtifactTransfer[]> {
        const transfers: StoredArtifactTransfer[] = [];
        for (const file of await listJsonFiles(this.#transfersDir)) {
            const stored = await readJsonFile<StoredArtifactTransfer>(join(this.#transfersDir, file));
            if (stored !== undefined && stored.version === ARTIFACT_RECORD_VERSION) {
                transfers.push(stored);
            }
        }
        return transfers;
    }

    async persistShare(share: StoredArtifactShare): Promise<void> {
        await atomicWriteJson(join(this.#sharesDir, `${share.result.shareId}.json`), share);
    }

    async persistTransfer(transfer: StoredArtifactTransfer): Promise<void> {
        await atomicWriteJson(join(this.#transfersDir, `${transfer.record.transferId}.json`), transfer);
    }
}

async function listJsonFiles(directory: string): Promise<string[]> {
    return (await readdir(directory)).filter((file) => file.endsWith(".json"));
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
        return undefined;
    }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(value)}\n`;
    await writeFile(temporaryPath, body, { mode: 0o600 });
    await rename(temporaryPath, path).catch(async (error) => {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    });
    await chmod(path, 0o600).catch(() => undefined);
}
