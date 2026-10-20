import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ContainerAdoptionIdentity {
    databaseFile: string;
    owner: string;
    /** Previous config-hash owner, used only for verified in-place migration. */
    previousOwner?: string;
    generation?: string;
    /** Shared across instance databases targeting the same provider resources. */
    resourceDirectory?: string;
}

export interface ContainerAdoptionRecord {
    owner: string;
    generation: string;
    containerId: string;
    startedAt: string;
    /** Persisted binding evidence permits migration without the old full config. */
    binding?: string;
    instanceOwner?: string;
    databaseFile?: string;
    retiring?: boolean;
    /** Resource-level fence retained until this physical start ends. */
    revoked?: boolean;
}

export interface AdoptionTransaction {
    read(): ContainerAdoptionRecord | undefined;
    write(record: ContainerAdoptionRecord): void;
    clear(): void;
}

const pending = new Map<string, Promise<void>>();

// One transaction covers verification, provider mutation and provenance update.
// SQLite also excludes a second controller process and releases its lock on crash.
export class ContainerAdoptionStore {
    readonly #file?: string;
    readonly #key: string;
    #memory?: DatabaseSync;

    constructor(file?: string) {
        this.#file = file === undefined ? undefined : resolve(file);
        this.#key = this.#file ?? randomUUID();
    }

    get identity(): string { return this.#key; }

    async transaction<T>(operation: (transaction: AdoptionTransaction) => Promise<T>): Promise<T> {
        const previous = pending.get(this.#key) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((resolvePromise) => { release = resolvePromise; });
        pending.set(this.#key, next);
        await previous;
        let database: DatabaseSync | undefined;
        let began = false;
        try {
            if (this.#file !== undefined) await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
            database = this.#file === undefined
                ? this.#memory ??= new DatabaseSync(":memory:")
                : new DatabaseSync(this.#file);
            database.exec("BEGIN IMMEDIATE");
            began = true;
            database.exec("CREATE TABLE IF NOT EXISTS adoption (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), record TEXT NOT NULL)");
            const db = database;
            const result = await operation({
                read: () => {
                    const row = db.prepare("SELECT record FROM adoption WHERE singleton = 1").get();
                    if (row === undefined) return undefined;
                    const record = JSON.parse(String(row.record)) as ContainerAdoptionRecord;
                    if (![record.owner, record.generation, record.containerId, record.startedAt].every((value) => typeof value === "string" && value.length > 0) ||
                        !/^[a-f0-9]{64}$/iu.test(record.containerId))
                        throw new Error("Invalid container adoption provenance.");
                    return record;
                },
                write: (record) => { db.prepare("INSERT OR REPLACE INTO adoption (singleton, record) VALUES (1, ?)").run(JSON.stringify(record)); },
                clear: () => { db.exec("DELETE FROM adoption"); },
            });
            database.exec("COMMIT");
            began = false;
            return result;
        } finally {
            try {
                if (began) database!.exec("ROLLBACK");
            } finally {
                try {
                    if (this.#file !== undefined) database?.close();
                } finally {
                    release();
                    if (pending.get(this.#key) === next) pending.delete(this.#key);
                }
            }
        }
    }
}

export function containerAdoptionOwner(config: unknown): string {
    return createHash("sha256").update(JSON.stringify(config, (_key, value: unknown) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    })).digest("hex");
}
