import { randomUUID } from "node:crypto";
import {
    chmod,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
    ARTIFACT_RECORD_VERSION,
    type StoredArtifactShare,
    type StoredArtifactTransfer,
} from "./Service.js";

export class ArtifactRecordStore {
    readonly #sharesDir: string;
    readonly #storageDir: string;
    readonly #transfersDir: string;
    readonly #writeQueues = new Map<string, Promise<void>>();

    constructor(storageDir: string) {
        this.#storageDir = storageDir;
        this.#sharesDir = join(storageDir, "shares");
        this.#transfersDir = join(storageDir, "transfers");
    }

    async initialize(): Promise<void> {
        await mkdir(this.#sharesDir, { mode: 0o700, recursive: true });
        await mkdir(this.#transfersDir, { mode: 0o700, recursive: true });
        await chmod(this.#storageDir, 0o700);
        await chmod(this.#sharesDir, 0o700);
        await chmod(this.#transfersDir, 0o700);
    }

    async loadShares(): Promise<StoredArtifactShare[]> {
        const shares: StoredArtifactShare[] = [];
        for (const file of await listJsonFiles(this.#sharesDir)) {
            const stored = await readJsonFile<StoredArtifactShare>(
                join(this.#sharesDir, file),
            );
            if (
                stored !== undefined &&
                stored.version === ARTIFACT_RECORD_VERSION
            ) {
                shares.push(stored);
            }
        }
        return shares;
    }

    async loadTransfers(): Promise<StoredArtifactTransfer[]> {
        const transfers: StoredArtifactTransfer[] = [];
        for (const file of await listJsonFiles(this.#transfersDir)) {
            const stored = await readJsonFile<StoredArtifactTransfer>(
                join(this.#transfersDir, file),
            );
            if (
                stored !== undefined &&
                stored.version === ARTIFACT_RECORD_VERSION
            ) {
                transfers.push(stored);
            }
        }
        return transfers;
    }

    async persistShare(share: StoredArtifactShare): Promise<void> {
        await this.#persistJson(
            join(this.#sharesDir, `${share.result.shareId}.json`),
            share,
        );
    }

    async persistTransfer(transfer: StoredArtifactTransfer): Promise<void> {
        await this.#persistJson(
            join(this.#transfersDir, `${transfer.record.transferId}.json`),
            transfer,
        );
    }

    async deleteShare(shareId: string): Promise<void> {
        await this.#deleteJson(join(this.#sharesDir, `${shareId}.json`));
    }

    async deleteTransfer(transferId: string): Promise<void> {
        await this.#deleteJson(join(this.#transfersDir, `${transferId}.json`));
    }

    async #persistJson(path: string, value: unknown): Promise<void> {
        const body = `${JSON.stringify(value)}\n`;
        const previous = this.#writeQueues.get(path) ?? Promise.resolve();
        const current = previous
            .catch(() => undefined)
            .then(async () => await atomicWriteJson(path, body));
        this.#writeQueues.set(path, current);
        try {
            await current;
        } finally {
            if (this.#writeQueues.get(path) === current) {
                this.#writeQueues.delete(path);
            }
        }
    }

    async #deleteJson(path: string): Promise<void> {
        const previous = this.#writeQueues.get(path) ?? Promise.resolve();
        const current = previous
            .catch(() => undefined)
            .then(async () => {
                await rm(path, { force: true });
                await syncDirectory(dirname(path));
            });
        this.#writeQueues.set(path, current);
        try {
            await current;
        } finally {
            if (this.#writeQueues.get(path) === current) {
                this.#writeQueues.delete(path);
            }
        }
    }
}

async function listJsonFiles(directory: string): Promise<string[]> {
    return (await readdir(directory)).filter((file) => file.endsWith(".json"));
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
    let body: string;
    try {
        body = await readFile(path, "utf8");
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    try {
        return JSON.parse(body) as T;
    } catch {
        return undefined;
    }
}

async function atomicWriteJson(path: string, body: string): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
        await file.writeFile(body, "utf8");
        await file.sync();
        if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    } catch (error) {
        await file.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
    await file.close();
    await rename(temporaryPath, path).catch(async (error) => {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    });
    await syncDirectory(dirname(path));
}

async function syncDirectory(directoryPath: string): Promise<void> {
    if (process.platform === "win32") return;
    const directory = await open(directoryPath, "r");
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}
