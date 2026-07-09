import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Adapter, AdapterFactory, AdapterPayload } from "oidc-provider";

interface StoredRecord {
    consumed?: number;
    expiresAt?: number;
    payload: AdapterPayload;
}

type StoredState = Record<string, StoredRecord>;

export function createMcpOidcFileAdapterFactory(storageDir: string): AdapterFactory {
    return (name: string) => new McpOidcFileAdapter(name, storageDir);
}

class McpOidcFileAdapter implements Adapter {
    readonly #filePath: string;

    constructor(name: string, storageDir: string) {
        this.#filePath = join(storageDir, `${name}.json`);
    }

    async consume(id: string): Promise<void> {
        const state = await this.#readState();
        const record = state[id];

        if (record === undefined) {
            return;
        }

        record.consumed = Math.floor(Date.now() / 1000);
        await this.#writeState(state);
    }

    async destroy(id: string): Promise<void> {
        const state = await this.#readState();
        delete state[id];
        await this.#writeState(state);
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
        const state = await this.#readState();
        const record = state[id];

        if (record === undefined || isExpired(record)) {
            if (record !== undefined) {
                delete state[id];
                await this.#writeState(state);
            }
            return undefined;
        }

        return toAdapterPayload(record);
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
        return await this.#findBy((record) => record.payload.uid === uid);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
        return await this.#findBy((record) => record.payload.userCode === userCode);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
        const state = await this.#readState();
        let changed = false;

        for (const [id, record] of Object.entries(state)) {
            if (record.payload.grantId === grantId) {
                delete state[id];
                changed = true;
            }
        }

        if (changed) {
            await this.#writeState(state);
        }
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
        const state = await this.#readState();
        state[id] = {
            expiresAt: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
            payload
        };
        await this.#writeState(state);
    }

    async #findBy(predicate: (record: StoredRecord) => boolean): Promise<AdapterPayload | undefined> {
        const state = await this.#readState();
        let changed = false;

        for (const [id, record] of Object.entries(state)) {
            if (isExpired(record)) {
                delete state[id];
                changed = true;
                continue;
            }

            if (predicate(record)) {
                if (changed) {
                    await this.#writeState(state);
                }
                return toAdapterPayload(record);
            }
        }

        if (changed) {
            await this.#writeState(state);
        }

        return undefined;
    }

    async #readState(): Promise<StoredState> {
        try {
            const source = await readFile(this.#filePath, "utf8");
            return JSON.parse(source) as StoredState;
        } catch (error) {
            if (isMissing(error)) {
                return {};
            }

            throw error;
        }
    }

    async #writeState(state: StoredState): Promise<void> {
        await mkdir(dirname(this.#filePath), { recursive: true });
        const tempPath = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tempPath, JSON.stringify(state), "utf8");
        await rename(tempPath, this.#filePath);
    }
}

function isExpired(record: StoredRecord): boolean {
    return typeof record.expiresAt === "number" && record.expiresAt <= Math.floor(Date.now() / 1000);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function toAdapterPayload(record: StoredRecord): AdapterPayload {
    return {
        ...record.payload,
        ...(record.consumed === undefined ? {} : { consumed: record.consumed })
    };
}
