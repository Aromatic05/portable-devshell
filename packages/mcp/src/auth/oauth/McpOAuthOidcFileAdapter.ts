import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import type { Adapter, AdapterFactory, AdapterPayload } from "oidc-provider";

interface StoredRecord {
    consumed?: number;
    expiresAt?: number;
    payload: AdapterPayload;
}

type StoredState = Record<string, StoredRecord>;

interface SharedAdapterState {
    readonly lock: AsyncMutex;
    state?: StoredState;
}

const MAX_CLIENT_RECORDS = 256;
const MAX_DEFAULT_RECORDS = 4096;
const sharedStores = new Map<string, SharedAdapterState>();

export function createMcpOAuthOidcFileAdapterFactory(
    storageDir: string,
    secureStorage: (path: string) => Promise<void> = async () => {},
): AdapterFactory {
    return (name: string) => {
        const filePath = join(storageDir, `${name}.json`);
        let store = sharedStores.get(filePath);
        if (store === undefined) {
            store = { lock: new AsyncMutex() };
            sharedStores.set(filePath, store);
        }
        return new McpOidcFileAdapter(
            filePath,
            store,
            name === "Client" ? MAX_CLIENT_RECORDS : MAX_DEFAULT_RECORDS,
            secureStorage,
        );
    };
}

class McpOidcFileAdapter implements Adapter {
    constructor(
        private readonly filePath: string,
        private readonly store: SharedAdapterState,
        private readonly maxRecords: number,
        private readonly secureStorage: (path: string) => Promise<void>,
    ) {}

    async consume(id: string): Promise<void> {
        await this.store.lock.runExclusive(async () => {
            const state = await this.#state();
            const record = state[id];
            if (record === undefined) {
                return;
            }
            await this.#commit({
                ...state,
                [id]: { ...record, consumed: Math.floor(Date.now() / 1000) }
            });
        });
    }

    async destroy(id: string): Promise<void> {
        await this.store.lock.runExclusive(async () => {
            const state = await this.#state();
            if (state[id] === undefined) {
                return;
            }
            const next = { ...state };
            delete next[id];
            await this.#commit(next);
        });
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
        return await this.store.lock.runExclusive(async () => {
            const state = await this.#state();
            const record = state[id];
            if (record === undefined) {
                return undefined;
            }
            if (isExpired(record)) {
                const next = { ...state };
                delete next[id];
                await this.#commit(next);
                return undefined;
            }
            return toAdapterPayload(record);
        });
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
        return await this.#findBy((record) => record.payload.uid === uid);
    }

    async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
        return await this.#findBy((record) => record.payload.userCode === userCode);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
        await this.store.lock.runExclusive(async () => {
            const current = await this.#state();
            const pruned = pruneExpiredCopy(current);
            const state = pruned.state === current ? { ...current } : pruned.state;
            let changed = pruned.changed;
            for (const [id, record] of Object.entries(current)) {
                if (record.payload.grantId === grantId) {
                    delete state[id];
                    changed = true;
                }
            }
            if (changed) {
                await this.#commit(state);
            }
        });
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
        await this.store.lock.runExclusive(async () => {
            const current = await this.#state();
            const pruned = pruneExpiredCopy(current);
            const state = pruned.state === current ? { ...current } : pruned.state;
            if (state[id] === undefined && Object.keys(state).length >= this.maxRecords) {
                throw new Error(`OIDC ${this.#modelName()} storage limit of ${this.maxRecords} records was reached.`);
            }
            state[id] = {
                expiresAt: expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
                payload: structuredClone(payload)
            };
            await this.#commit(state);
        });
    }

    async #findBy(predicate: (record: StoredRecord) => boolean): Promise<AdapterPayload | undefined> {
        return await this.store.lock.runExclusive(async () => {
            const current = await this.#state();
            const pruned = pruneExpiredCopy(current);
            const state = pruned.state;
            const record = Object.values(state).find(predicate);
            if (pruned.changed) {
                await this.#commit(state);
            }
            return record === undefined ? undefined : toAdapterPayload(record);
        });
    }

    async #state(): Promise<StoredState> {
        if (this.store.state === undefined) {
            this.store.state = await this.#readState();
        }
        return this.store.state;
    }

    async #commit(state: StoredState): Promise<void> {
        try {
            await this.#writeState(state);
            this.store.state = state;
        } catch (error) {
            this.store.state = undefined;
            throw error;
        }
    }

    async #readState(): Promise<StoredState> {
        try {
            const source = await readFile(this.filePath, "utf8");
            const value = JSON.parse(source) as unknown;
            if (!isStoredState(value)) {
                throw new Error(`Invalid OIDC adapter state: ${this.filePath}`);
            }
            return value;
        } catch (error) {
            if (isMissing(error)) {
                return {};
            }
            throw error;
        }
    }

    async #writeState(state: StoredState): Promise<void> {
        const directory = dirname(this.filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        if (process.platform !== "win32") {
            await chmod(directory, 0o700);
        }
        await this.secureStorage(directory);
        const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        const file = await open(tempPath, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify(state), "utf8");
            await file.sync();
        } catch (error) {
            await file.close().catch(() => undefined);
            await rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
        await file.close();
        try {
            await rename(tempPath, this.filePath);
            if (process.platform !== "win32") {
                await chmod(this.filePath, 0o600);
                const directoryHandle = await open(directory, "r");
                try {
                    await directoryHandle.sync();
                } finally {
                    await directoryHandle.close();
                }
            }
            await this.secureStorage(directory);
        } catch (error) {
            await rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    #modelName(): string {
        return basename(this.filePath, extname(this.filePath));
    }
}

class AsyncMutex {
    #tail: Promise<void> = Promise.resolve();

    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#tail;
        let release!: () => void;
        this.#tail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function pruneExpiredCopy(state: StoredState): { changed: boolean; state: StoredState } {
    let next = state;
    for (const [id, record] of Object.entries(state)) {
        if (isExpired(record)) {
            if (next === state) next = { ...state };
            delete next[id];
        }
    }
    return { changed: next !== state, state: next };
}

function isExpired(record: StoredRecord): boolean {
    return typeof record.expiresAt === "number" && record.expiresAt <= Math.floor(Date.now() / 1000);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isStoredState(value: unknown): value is StoredState {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    return Object.values(value).every((record) => {
        return typeof record === "object" && record !== null && !Array.isArray(record) &&
            "payload" in record && typeof record.payload === "object" && record.payload !== null;
    });
}

function toAdapterPayload(record: StoredRecord): AdapterPayload {
    return structuredClone({
        ...record.payload,
        ...(record.consumed === undefined ? {} : { consumed: record.consumed })
    });
}
