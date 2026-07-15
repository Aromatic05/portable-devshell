import { createRequire } from "node:module";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { AuditRecordStore } from "./AuditRecordStore.js";
import { minimumAuditStorageBytes } from "./AuditStorageLimits.js";

export type AuditRecordCollection = "approvals" | "events" | "logs" | "toolCalls";

export interface AuditDatabaseOptions {
    maxBytes: number;
    now?: () => number;
    retentionDays: number;
}

export interface AuditStoreOptions<TRecord> {
    legacyFile?: string;
    sequence?: (record: TRecord) => number;
    timestamp: (record: TRecord) => number | string;
}

export interface AuditDatabaseStats {
    fileBytes: number;
    payloadBytes: number;
    recordCount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEMA_VERSION = 1;

export class AuditDatabase {
    readonly #database: DatabaseSync;
    readonly #maxBytes: number;
    readonly #now: () => number;
    readonly #retentionMs: number;
    #closed = false;

    constructor(filePath: string, options: AuditDatabaseOptions) {
        validateOptions(options);
        mkdirSync(dirname(filePath), { recursive: true });
        const Database = loadDatabaseSync();
        this.#database = new Database(filePath, { timeout: 5_000 });
        this.#maxBytes = options.maxBytes;
        this.#now = options.now ?? Date.now;
        this.#retentionMs = options.retentionDays * DAY_MS;
        this.#initializeSchema();
        this.cleanup();
    }

    store<TRecord>(collection: AuditRecordCollection, options: AuditStoreOptions<TRecord>): AuditRecordStore<TRecord> {
        this.#assertOpen();
        this.migrateLegacy(collection, options);
        return new AuditRecordStoreSqlite(this, collection, options);
    }

    close(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#database.close();
    }

    cleanup(): void {
        this.#assertOpen();
        const cutoff = this.#now() - this.#retentionMs;
        this.#database.prepare("DELETE FROM audit_records WHERE occurred_at_ms < ?").run(cutoff);
        this.#evictForPayloadLimit();
        this.#compact();
        this.#evictForFileLimit();
    }

    stats(): AuditDatabaseStats {
        this.#assertOpen();
        this.cleanup();
        const row = this.#database
            .prepare("SELECT COUNT(*) AS recordCount, COALESCE(SUM(payload_bytes), 0) AS payloadBytes FROM audit_records")
            .get() as { payloadBytes: number; recordCount: number };
        return {
            fileBytes: readPragmaNumber(this.#database, "page_count") * readPragmaNumber(this.#database, "page_size"),
            payloadBytes: row.payloadBytes,
            recordCount: row.recordCount
        };
    }

    appendRecord<TRecord>(
        collection: AuditRecordCollection,
        record: TRecord,
        options: AuditStoreOptions<TRecord>
    ): void {
        this.#assertOpen();
        this.#insertRecord(collection, record, options);
        this.cleanup();
    }

    readRecords<TRecord>(collection: AuditRecordCollection): TRecord[] {
        this.#assertOpen();
        this.cleanup();
        return (this.#database
            .prepare("SELECT payload FROM audit_records WHERE collection = ? ORDER BY id ASC")
            .all(collection) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as TRecord);
    }

    readHighWater(collection: AuditRecordCollection): number {
        this.#assertOpen();
        const value = this.#readMetadata(`highWater:${collection}`);
        return value === undefined ? 0 : Number(value);
    }

    migrateLegacy<TRecord>(
        collection: AuditRecordCollection,
        options: AuditStoreOptions<TRecord>
    ): void {
        this.#assertOpen();
        const migrationKey = `migration:jsonl-v1:${collection}`;
        if (this.#readMetadata(migrationKey) === "complete") {
            return;
        }

        const records = readLegacyRecords<TRecord>(options.legacyFile);
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            for (const record of records) {
                this.#insertRecord(collection, record, options);
            }
            this.#writeMetadata(migrationKey, "complete");
            this.#database.exec("COMMIT");
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }

        if (options.legacyFile !== undefined) {
            try {
                unlinkSync(options.legacyFile);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
        }
        this.cleanup();
    }

    #initializeSchema(): void {
        this.#database.exec("PRAGMA journal_mode = TRUNCATE");
        this.#database.exec("PRAGMA synchronous = NORMAL");
        this.#database.exec("PRAGMA auto_vacuum = INCREMENTAL");
        this.#database.exec(`
            CREATE TABLE IF NOT EXISTS audit_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL,
                payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                payload TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS audit_records_collection_id
                ON audit_records(collection, id);
            CREATE INDEX IF NOT EXISTS audit_records_occurred_at
                ON audit_records(occurred_at_ms, id);
            CREATE TABLE IF NOT EXISTS audit_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = ${SCHEMA_VERSION};
        `);
    }

    #insertRecord<TRecord>(
        collection: AuditRecordCollection,
        record: TRecord,
        options: AuditStoreOptions<TRecord>
    ): void {
        const payload = JSON.stringify(record);
        const occurredAtMs = normalizeTimestamp(options.timestamp(record), this.#now());
        this.#database
            .prepare("INSERT INTO audit_records(collection, occurred_at_ms, payload_bytes, payload) VALUES (?, ?, ?, ?)")
            .run(collection, occurredAtMs, Buffer.byteLength(payload, "utf8"), payload);

        const sequence = options.sequence?.(record);
        if (sequence !== undefined) {
            if (!Number.isSafeInteger(sequence) || sequence < 0) {
                throw new TypeError(`Invalid ${collection} sequence: ${sequence}`);
            }
            const current = this.readHighWater(collection);
            if (sequence > current) {
                this.#writeMetadata(`highWater:${collection}`, String(sequence));
            }
        }
    }

    #payloadBytes(): number {
        const row = this.#database
            .prepare("SELECT COALESCE(SUM(payload_bytes), 0) AS payloadBytes FROM audit_records")
            .get() as { payloadBytes: number };
        return row.payloadBytes;
    }

    #fileBytes(): number {
        return readPragmaNumber(this.#database, "page_count") * readPragmaNumber(this.#database, "page_size");
    }

    #evictForPayloadLimit(): void {
        let payloadBytes = this.#payloadBytes();
        if (payloadBytes <= this.#maxBytes) {
            return;
        }
        const rows = this.#database
            .prepare("SELECT id, payload_bytes AS payloadBytes FROM audit_records ORDER BY id ASC")
            .all() as Array<{ id: number; payloadBytes: number }>;
        let cutoffId: number | undefined;
        for (const row of rows) {
            if (payloadBytes <= this.#maxBytes) {
                break;
            }
            payloadBytes -= row.payloadBytes;
            cutoffId = row.id;
        }
        if (cutoffId !== undefined) {
            this.#database.prepare("DELETE FROM audit_records WHERE id <= ?").run(cutoffId);
        }
    }

    #evictForFileLimit(): void {
        let previousFileBytes = Number.POSITIVE_INFINITY;
        while (this.#fileBytes() > this.#maxBytes) {
            const rows = this.#database
                .prepare("SELECT id FROM audit_records ORDER BY id ASC LIMIT 256")
                .all() as Array<{ id: number }>;
            if (rows.length === 0) {
                throw new Error(`audit database cannot fit within maxBytes=${this.#maxBytes}`);
            }
            const cutoffId = rows[rows.length - 1]!.id;
            this.#database.prepare("DELETE FROM audit_records WHERE id <= ?").run(cutoffId);
            this.#compact();
            const fileBytes = this.#fileBytes();
            if (fileBytes >= previousFileBytes) {
                this.#database.exec("VACUUM");
            }
            previousFileBytes = this.#fileBytes();
        }
    }

    #compact(): void {
        const freelist = readPragmaNumber(this.#database, "freelist_count");
        if (freelist > 0) {
            this.#database.exec(`PRAGMA incremental_vacuum(${freelist})`);
        }
    }

    #readMetadata(key: string): string | undefined {
        const row = this.#database.prepare("SELECT value FROM audit_metadata WHERE key = ?").get(key) as
            | { value: string }
            | undefined;
        return row?.value;
    }

    #writeMetadata(key: string, value: string): void {
        this.#database
            .prepare("INSERT INTO audit_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(key, value);
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new Error("SQLite audit database is closed.");
        }
    }
}

class AuditRecordStoreSqlite<TRecord> implements AuditRecordStore<TRecord> {
    readonly #collection: AuditRecordCollection;
    readonly #database: AuditDatabase;
    readonly #options: AuditStoreOptions<TRecord>;

    constructor(
        database: AuditDatabase,
        collection: AuditRecordCollection,
        options: AuditStoreOptions<TRecord>
    ) {
        this.#collection = collection;
        this.#database = database;
        this.#options = options;
    }

    async append(record: TRecord): Promise<void> {
        this.#database.appendRecord(this.#collection, record, this.#options);
    }

    async readAll(): Promise<TRecord[]> {
        return this.#database.readRecords<TRecord>(this.#collection);
    }

    async readHighWater(): Promise<number> {
        return this.#database.readHighWater(this.#collection);
    }
}

function readLegacyRecords<TRecord>(filePath: string | undefined): TRecord[] {
    if (filePath === undefined) {
        return [];
    }
    let contents: string;
    try {
        contents = readFileSync(filePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw error;
    }
    return contents
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TRecord);
}

function normalizeTimestamp(value: number | string, fallback: number): number {
    const parsed = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function readPragmaNumber(database: DatabaseSync, name: "freelist_count" | "page_count" | "page_size"): number {
    const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
    return Number(Object.values(row)[0] ?? 0);
}

function validateOptions(options: AuditDatabaseOptions): void {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < minimumAuditStorageBytes) {
        throw new TypeError(`maxBytes must be an integer of at least ${minimumAuditStorageBytes}.`);
    }
    if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
        throw new TypeError("retentionDays must be a positive safe integer.");
    }
}

function loadDatabaseSync(): typeof import("node:sqlite").DatabaseSync {
    const require = createRequire(import.meta.url);
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
        const message = warning instanceof Error ? warning.message : warning;
        const type = typeof args[0] === "string"
            ? args[0]
            : typeof args[0] === "object" && args[0] !== null && "type" in args[0]
              ? String((args[0] as { type?: unknown }).type)
              : undefined;
        if (type === "ExperimentalWarning" && message.includes("SQLite")) {
            return;
        }
        Reflect.apply(originalEmitWarning, process, [warning, ...args]);
    }) as typeof process.emitWarning;
    try {
        return (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
    } finally {
        process.emitWarning = originalEmitWarning;
    }
}
