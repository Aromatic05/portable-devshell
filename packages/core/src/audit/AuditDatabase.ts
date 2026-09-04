import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import type { ToolCallQuery, ToolCallRecord } from "@portable-devshell/shared";

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

export interface AuditToolCallFailureSummary {
    count: number;
    latest?: ToolCallRecord;
}

export interface AuditToolCallRecordStore extends AuditRecordStore<ToolCallRecord> {
    hasCall(callId: string): Promise<boolean>;
    readFailureSummary(sinceMs: number, untilMs: number): Promise<AuditToolCallFailureSummary>;
    readQuery(query: ToolCallQuery): Promise<ToolCallRecord[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IDENTITY_BODY_CODEC = "identity";
const LOG_BODY_COMPRESSION_THRESHOLD_BYTES = 8 * 1024;
const LOG_BODY_COMPRESSION_SAMPLE_BYTES = 32 * 1024;
const LOG_BODY_SAMPLE_MAX_RATIO = 0.7;
const ROUTINE_INCREMENTAL_VACUUM_PAGES = 64;
const SCHEMA_VERSION = 2;
const WAL_AUTOCHECKPOINT_PAGES = 1_000;
const WAL_JOURNAL_SIZE_LIMIT_BYTES = 1024 * 1024;
const ZSTD_BODY_CODEC = "zstd";
const ZSTD_COMPRESSION_LEVEL = 1;

interface AuditStoredRow {
    body: Uint8Array | null;
    bodyCodec: string | null;
    payload: string;
}

export class AuditDatabase {
    #databaseHandle?: DatabaseSync;
    readonly #filePath: string;
    readonly #maxBytes: number;
    readonly #now: () => number;
    readonly #retentionMs: number;
    #closed = false;
    #payloadBytes = 0;

    constructor(filePath: string, options: AuditDatabaseOptions) {
        validateOptions(options);
        this.#filePath = filePath;
        this.#maxBytes = options.maxBytes;
        this.#now = options.now ?? Date.now;
        this.#retentionMs = options.retentionDays * DAY_MS;
    }

    store<TRecord>(collection: AuditRecordCollection, options: AuditStoreOptions<TRecord>): AuditRecordStore<TRecord> {
        this.#assertOpen();
        return new AuditRecordStoreSqlite(this, collection, options);
    }

    toolCallStore(options: AuditStoreOptions<ToolCallRecord>): AuditToolCallRecordStore {
        this.#assertOpen();
        return new AuditToolCallRecordStoreSqlite(this, options);
    }

    close(): void {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        const database = this.#databaseHandle;
        if (database !== undefined) {
            this.#checkpointWal(true, database);
            database.close();
            this.#databaseHandle = undefined;
        }
    }

    cleanup(): void {
        this.#assertOpen();
        const cutoff = this.#now() - this.#retentionMs;
        const expired = this.#database.prepare("DELETE FROM audit_records WHERE occurred_at_ms < ?").run(cutoff);
        if (expired.changes > 0) {
            this.#payloadBytes = this.#readPayloadBytes();
        }
        this.#evictForPayloadLimit();
        this.#compact();
        this.#evictForFileLimit();
    }

    stats(): AuditDatabaseStats {
        this.#assertOpen();
        this.cleanup();
        const row = this.#database
            .prepare("SELECT COUNT(*) AS recordCount FROM audit_records")
            .get() as { recordCount: number };
        return {
            fileBytes: this.#fileBytes(),
            payloadBytes: this.#payloadBytes,
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
        return (this.#database
            .prepare("SELECT payload, body, body_codec AS bodyCodec FROM audit_records WHERE collection = ? AND occurred_at_ms >= ? ORDER BY id ASC")
            .all(collection, this.#retentionCutoff()) as unknown as AuditStoredRow[])
            .map((row) => decodeStoredRecord<TRecord>(collection, row));
    }

    readTailRecords<TRecord>(collection: AuditRecordCollection, limit: number): TRecord[] {
        this.#assertOpen();
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new TypeError(`Invalid audit tail limit: ${limit}`);
        }
        const rows = this.#database
            .prepare("SELECT payload, body, body_codec AS bodyCodec FROM audit_records WHERE collection = ? AND occurred_at_ms >= ? ORDER BY id DESC LIMIT ?")
            .all(collection, this.#retentionCutoff(), limit) as unknown as AuditStoredRow[];
        rows.reverse();
        return rows.map((row) => decodeStoredRecord<TRecord>(collection, row));
    }

    readSequenceRecords<TRecord>(
        collection: AuditRecordCollection,
        fromSeq: number,
        limit?: number,
        maxDecodedBytes?: number,
    ): TRecord[] {
        this.#assertOpen();
        if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
            throw new TypeError(`Invalid audit sequence start: ${fromSeq}.`);
        }
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
            throw new TypeError(`Invalid audit sequence limit: ${limit}.`);
        }
        if (maxDecodedBytes !== undefined && (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1)) {
            throw new TypeError(`Invalid audit decoded byte limit: ${maxDecodedBytes}.`);
        }
        const collectionSql = auditCollectionSql(collection);
        const statement = this.#database.prepare(
            `SELECT payload, body, body_codec AS bodyCodec FROM audit_records
             WHERE collection = ${collectionSql} AND occurred_at_ms >= ? AND json_extract(payload, '$.seq') >= ?
             ORDER BY id ASC${limit === undefined ? "" : " LIMIT ?"}`
        );
        const parameters = limit === undefined
            ? [this.#retentionCutoff(), fromSeq]
            : [this.#retentionCutoff(), fromSeq, limit];
        const records: TRecord[] = [];
        let decodedBytes = 0;
        for (const value of statement.iterate(...parameters)) {
            const record = decodeStoredRecord<TRecord>(collection, value as unknown as AuditStoredRow);
            records.push(record);
            if (collection === "logs" && maxDecodedBytes !== undefined) {
                decodedBytes += decodedLogMessageBytes(record);
                if (decodedBytes >= maxDecodedBytes) break;
            }
        }
        return records;
    }

    readToolCallRecords(query: ToolCallQuery): ToolCallRecord[] {
        this.#assertOpen();
        if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
            throw new TypeError(`Invalid audit tool-call limit: ${query.limit}.`);
        }
        const predicates = ["collection = 'toolCalls'", "occurred_at_ms >= ?"];
        const parameters: Array<number | string> = [this.#retentionCutoff()];
        if (query.after !== undefined) {
            const afterId = this.#readToolCallId(query.after);
            if (afterId === undefined) return [];
            predicates.push("id > ?");
            parameters.push(afterId);
        }
        if (query.before !== undefined) {
            const beforeId = this.#readToolCallId(query.before);
            if (beforeId === undefined) return [];
            predicates.push("id < ?");
            parameters.push(beforeId);
        }
        if (query.callIds !== undefined) {
            if (query.callIds.length === 0) return [];
            predicates.push(`json_extract(payload, '$.callId') IN (${query.callIds.map(() => "?").join(", ")})`);
            parameters.push(...query.callIds);
        }
        if (query.ctxId !== undefined) {
            predicates.push("json_extract(payload, '$.ctxId') = ?");
            parameters.push(query.ctxId);
        }
        if (query.source !== undefined) {
            predicates.push("json_extract(payload, '$.source') = ?");
            parameters.push(query.source);
        }
        if (query.status !== undefined) {
            predicates.push("json_extract(payload, '$.status') = ?");
            parameters.push(query.status);
        }
        if (query.toolName !== undefined) {
            predicates.push("json_extract(payload, '$.toolName') = ?");
            parameters.push(query.toolName);
        }

        const limited = query.limit !== undefined;
        const newestFirst = limited && query.after === undefined;
        const rows = this.#database.prepare(
            `SELECT payload FROM audit_records WHERE ${predicates.join(" AND ")} ORDER BY id ${newestFirst ? "DESC" : "ASC"}${limited ? " LIMIT ?" : ""}`
        ).all(...(limited ? [...parameters, query.limit!] : parameters)) as Array<{ payload: string }>;
        if (newestFirst) rows.reverse();
        return rows.map((row) => JSON.parse(row.payload) as ToolCallRecord);
    }

    hasToolCallRecord(callId: string): boolean {
        this.#assertOpen();
        return this.#readToolCallId(callId) !== undefined;
    }

    readToolCallFailureSummary(sinceMs: number, untilMs: number): AuditToolCallFailureSummary {
        this.#assertOpen();
        if (!Number.isSafeInteger(sinceMs) || !Number.isSafeInteger(untilMs) || sinceMs > untilMs) {
            throw new TypeError("Invalid audit tool-call failure window.");
        }
        const effectiveSinceMs = Math.max(sinceMs, this.#retentionCutoff());
        if (effectiveSinceMs > untilMs) return { count: 0 };
        const where = `
            collection = 'toolCalls' AND
            occurred_at_ms >= ? AND occurred_at_ms <= ? AND
            json_extract(payload, '$.status') IN ('failed', 'queueTimeout')
        `;
        const count = this.#database
            .prepare(`SELECT COUNT(*) AS count FROM audit_records WHERE ${where}`)
            .get(effectiveSinceMs, untilMs) as { count: number };
        if (count.count === 0) return { count: 0 };
        const latest = this.#database
            .prepare(`SELECT payload FROM audit_records WHERE ${where} ORDER BY occurred_at_ms DESC, id DESC LIMIT 1`)
            .get(effectiveSinceMs, untilMs) as { payload: string } | undefined;
        return {
            count: count.count,
            ...(latest === undefined ? {} : { latest: JSON.parse(latest.payload) as ToolCallRecord }),
        };
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
        const payloadBytesBefore = this.#payloadBytes;
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            for (const record of records) {
                this.#insertRecord(collection, record, options);
            }
            this.#writeMetadata(migrationKey, "complete");
            this.#database.exec("COMMIT");
        } catch (error) {
            this.#database.exec("ROLLBACK");
            this.#payloadBytes = payloadBytesBefore;
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
        this.#database.exec("PRAGMA journal_mode = WAL");
        this.#database.exec("PRAGMA synchronous = NORMAL");
        this.#database.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
        this.#database.exec(`PRAGMA journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
        this.#database.exec("PRAGMA auto_vacuum = INCREMENTAL");
        this.#database.exec(`
            CREATE TABLE IF NOT EXISTS audit_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL,
                payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                payload TEXT NOT NULL,
                body BLOB,
                body_codec TEXT
            ) STRICT;
            CREATE INDEX IF NOT EXISTS audit_records_collection_id
                ON audit_records(collection, id);
            CREATE INDEX IF NOT EXISTS audit_records_occurred_at
                ON audit_records(occurred_at_ms, id);
            CREATE INDEX IF NOT EXISTS audit_records_tool_call_status_time
                ON audit_records(json_extract(payload, '$.status'), occurred_at_ms DESC, id DESC)
                WHERE collection = 'toolCalls';
            CREATE INDEX IF NOT EXISTS audit_records_tool_call_call_id
                ON audit_records(json_extract(payload, '$.callId'), id)
                WHERE collection = 'toolCalls';
            CREATE INDEX IF NOT EXISTS audit_records_tool_call_ctx_id
                ON audit_records(json_extract(payload, '$.ctxId'), id)
                WHERE collection = 'toolCalls';
            DROP INDEX IF EXISTS audit_records_collection_sequence;
            CREATE INDEX IF NOT EXISTS audit_records_log_sequence
                ON audit_records(json_extract(payload, '$.seq'), id)
                WHERE collection = 'logs';
            CREATE INDEX IF NOT EXISTS audit_records_event_sequence
                ON audit_records(json_extract(payload, '$.seq'), id)
                WHERE collection = 'events';
            CREATE TABLE IF NOT EXISTS audit_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
        `);
        this.#upgradeSchema();
    }

    #insertRecord<TRecord>(
        collection: AuditRecordCollection,
        record: TRecord,
        options: AuditStoreOptions<TRecord>
    ): void {
        const stored = encodeStoredRecord(collection, record);
        const occurredAtMs = normalizeTimestamp(options.timestamp(record), this.#now());
        this.#database
            .prepare("INSERT INTO audit_records(collection, occurred_at_ms, payload_bytes, payload, body, body_codec) VALUES (?, ?, ?, ?, ?, ?)")
            .run(collection, occurredAtMs, stored.payloadBytes, stored.payload, stored.body, stored.bodyCodec);
        this.#payloadBytes += stored.payloadBytes;

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

    #upgradeSchema(): void {
        const columns = new Set(
            (this.#database.prepare("PRAGMA table_info(audit_records)").all() as Array<{ name: string }>)
                .map((column) => column.name)
        );
        const userVersion = readPragmaNumber(this.#database, "user_version");
        if (columns.has("body") && columns.has("body_codec") && userVersion >= SCHEMA_VERSION) {
            return;
        }
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            if (!columns.has("body")) {
                this.#database.exec("ALTER TABLE audit_records ADD COLUMN body BLOB");
            }
            if (!columns.has("body_codec")) {
                this.#database.exec("ALTER TABLE audit_records ADD COLUMN body_codec TEXT");
            }
            this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            this.#database.exec("COMMIT");
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    }

    #readPayloadBytes(): number {
        const row = this.#database
            .prepare("SELECT COALESCE(SUM(payload_bytes), 0) AS payloadBytes FROM audit_records")
            .get() as { payloadBytes: number };
        return row.payloadBytes;
    }

    #readToolCallId(callId: string): number | undefined {
        const row = this.#database.prepare(
            "SELECT id FROM audit_records WHERE collection = 'toolCalls' AND occurred_at_ms >= ? AND json_extract(payload, '$.callId') = ? ORDER BY id DESC LIMIT 1"
        ).get(this.#retentionCutoff(), callId) as { id: number } | undefined;
        return row?.id;
    }

    #retentionCutoff(): number {
        return this.#now() - this.#retentionMs;
    }

    #fileBytes(): number {
        return fileSize(this.#filePath) + fileSize(`${this.#filePath}-wal`);
    }

    #evictForPayloadLimit(): void {
        let payloadBytes = this.#payloadBytes;
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
            this.#payloadBytes = payloadBytes;
        }
    }

    #evictForFileLimit(): void {
        if (this.#fileBytes() <= this.#maxBytes) return;
        this.#checkpointWal(true);
        if (this.#fileBytes() <= this.#maxBytes) return;
        this.#database.exec("VACUUM");
        this.#checkpointWal(true);
        if (this.#fileBytes() <= this.#maxBytes) return;

        let previousFileBytes = this.#fileBytes();
        while (this.#fileBytes() > this.#maxBytes) {
            const rows = this.#database
                .prepare("SELECT id, payload_bytes AS payloadBytes FROM audit_records ORDER BY id ASC LIMIT 256")
                .all() as Array<{ id: number; payloadBytes: number }>;
            if (rows.length === 0) {
                this.#database.exec("VACUUM");
                this.#checkpointWal(true);
                if (this.#fileBytes() > this.#maxBytes) {
                    throw new Error(`audit database cannot fit within maxBytes=${this.#maxBytes}`);
                }
                break;
            }
            const bytesToFree = Math.max(1, previousFileBytes - this.#maxBytes);
            let evictedPayloadBytes = 0;
            let cutoffId = rows[0]!.id;
            for (const row of rows) {
                cutoffId = row.id;
                evictedPayloadBytes += row.payloadBytes;
                if (evictedPayloadBytes >= bytesToFree) break;
            }
            this.#database.prepare("DELETE FROM audit_records WHERE id <= ?").run(cutoffId);
            this.#payloadBytes = Math.max(
                0,
                this.#payloadBytes - evictedPayloadBytes,
            );
            this.#compact(true);
            this.#checkpointWal(true);
            const fileBytes = this.#fileBytes();
            if (fileBytes >= previousFileBytes) {
                this.#database.exec("VACUUM");
                this.#checkpointWal(true);
            }
            previousFileBytes = this.#fileBytes();
        }
    }

    #compact(aggressive = false): void {
        const freelist = readPragmaNumber(this.#database, "freelist_count");
        if (freelist > 0) {
            const pages = aggressive ? freelist : Math.min(freelist, ROUTINE_INCREMENTAL_VACUUM_PAGES);
            this.#database.exec(`PRAGMA incremental_vacuum(${pages})`);
        }
    }

    #checkpointWal(truncate: boolean, database: DatabaseSync = this.#database): void {
        database.exec(`PRAGMA wal_checkpoint(${truncate ? "TRUNCATE" : "PASSIVE"})`);
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

    get #database(): DatabaseSync {
        return this.#openDatabase();
    }

    #openDatabase(): DatabaseSync {
        this.#assertOpen();
        if (this.#databaseHandle !== undefined) return this.#databaseHandle;

        mkdirSync(dirname(this.#filePath), { recursive: true });
        const Database = loadDatabaseSync();
        const database = new Database(this.#filePath, { timeout: 5_000 });
        this.#databaseHandle = database;
        try {
            this.#initializeSchema();
            this.#payloadBytes = this.#readPayloadBytes();
            return database;
        } catch (error) {
            this.#databaseHandle = undefined;
            database.close();
            throw error;
        }
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
    #migrated = false;
    readonly readFromSeq?: (fromSeq: number, limit?: number, maxDecodedBytes?: number) => Promise<TRecord[]>;

    constructor(
        database: AuditDatabase,
        collection: AuditRecordCollection,
        options: AuditStoreOptions<TRecord>
    ) {
        this.#collection = collection;
        this.#database = database;
        this.#options = options;
        if (options.sequence !== undefined) {
            this.readFromSeq = async (fromSeq, limit, maxDecodedBytes) => {
                this.#ensureMigrated();
                return this.#database.readSequenceRecords<TRecord>(this.#collection, fromSeq, limit, maxDecodedBytes);
            };
        }
    }

    async append(record: TRecord): Promise<void> {
        this.#ensureMigrated();
        this.#database.appendRecord(this.#collection, record, this.#options);
    }

    async readAll(): Promise<TRecord[]> {
        this.#ensureMigrated();
        return this.#database.readRecords<TRecord>(this.#collection);
    }

    async readHighWater(): Promise<number> {
        this.#ensureMigrated();
        return this.#database.readHighWater(this.#collection);
    }

    async readTail(limit: number): Promise<TRecord[]> {
        this.#ensureMigrated();
        return this.#database.readTailRecords<TRecord>(this.#collection, limit);
    }

    #ensureMigrated(): void {
        if (this.#migrated) return;
        this.#database.migrateLegacy(this.#collection, this.#options);
        this.#migrated = true;
    }
}

class AuditToolCallRecordStoreSqlite implements AuditToolCallRecordStore {
    readonly #database: AuditDatabase;
    readonly #options: AuditStoreOptions<ToolCallRecord>;
    #migrated = false;

    constructor(database: AuditDatabase, options: AuditStoreOptions<ToolCallRecord>) {
        this.#database = database;
        this.#options = options;
    }

    async append(record: ToolCallRecord): Promise<void> {
        this.#ensureMigrated();
        this.#database.appendRecord("toolCalls", record, this.#options);
    }

    async hasCall(callId: string): Promise<boolean> {
        this.#ensureMigrated();
        return this.#database.hasToolCallRecord(callId);
    }

    async readAll(): Promise<ToolCallRecord[]> {
        this.#ensureMigrated();
        return this.#database.readRecords<ToolCallRecord>("toolCalls");
    }

    async readFailureSummary(sinceMs: number, untilMs: number): Promise<AuditToolCallFailureSummary> {
        this.#ensureMigrated();
        return this.#database.readToolCallFailureSummary(sinceMs, untilMs);
    }

    async readHighWater(): Promise<number> {
        this.#ensureMigrated();
        return this.#database.readHighWater("toolCalls");
    }

    async readQuery(query: ToolCallQuery): Promise<ToolCallRecord[]> {
        this.#ensureMigrated();
        return this.#database.readToolCallRecords(query);
    }

    async readTail(limit: number): Promise<ToolCallRecord[]> {
        this.#ensureMigrated();
        return this.#database.readTailRecords<ToolCallRecord>("toolCalls", limit);
    }

    #ensureMigrated(): void {
        if (this.#migrated) return;
        this.#database.migrateLegacy("toolCalls", this.#options);
        this.#migrated = true;
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

function encodeStoredRecord<TRecord>(
    collection: AuditRecordCollection,
    record: TRecord,
): AuditStoredRow & { payloadBytes: number } {
    if (collection !== "logs" || typeof record !== "object" || record === null || Array.isArray(record)) {
        return inlineStoredRecord(JSON.stringify(record));
    }

    const source = record as Record<string, unknown>;
    if (typeof source.message !== "string") {
        return inlineStoredRecord(JSON.stringify(record));
    }
    const messageBytes = Buffer.byteLength(source.message, "utf8");
    if (messageBytes < LOG_BODY_COMPRESSION_THRESHOLD_BYTES) {
        return inlineStoredRecord(JSON.stringify(record));
    }

    const { message: _message, ...metadata } = source;
    const payload = JSON.stringify(metadata);
    const message = Buffer.from(source.message, "utf8");
    const sample = message.subarray(0, Math.min(message.byteLength, LOG_BODY_COMPRESSION_SAMPLE_BYTES));
    const compressedSample = compressLogBody(sample);
    if (compressedSample.byteLength / sample.byteLength > LOG_BODY_SAMPLE_MAX_RATIO) {
        return bodyStoredRecord(payload, message, IDENTITY_BODY_CODEC);
    }

    const compressed = compressLogBody(message);
    if (compressed.byteLength >= message.byteLength) {
        return bodyStoredRecord(payload, message, IDENTITY_BODY_CODEC);
    }
    return bodyStoredRecord(payload, compressed, ZSTD_BODY_CODEC);
}

function bodyStoredRecord(payload: string, body: Uint8Array, bodyCodec: string): AuditStoredRow & { payloadBytes: number } {
    return {
        body,
        bodyCodec,
        payload,
        payloadBytes: Buffer.byteLength(payload, "utf8") + body.byteLength,
    };
}

function compressLogBody(body: Uint8Array): Buffer {
    return zstdCompressSync(body, {
        params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL }
    });
}

function inlineStoredRecord(payload: string): AuditStoredRow & { payloadBytes: number } {
    return {
        body: null,
        bodyCodec: null,
        payload,
        payloadBytes: Buffer.byteLength(payload, "utf8"),
    };
}

function decodeStoredRecord<TRecord>(collection: AuditRecordCollection, row: AuditStoredRow): TRecord {
    const payload = JSON.parse(row.payload) as unknown;
    if (row.bodyCodec === null) {
        if (row.body !== null) {
            throw new Error("Audit record has a body without a codec.");
        }
        return payload as TRecord;
    }
    if (collection !== "logs" || row.body === null) {
        throw new Error(`Unsupported audit record body codec: ${row.bodyCodec}.`);
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("Externalized audit log metadata must be an object.");
    }
    const message = row.bodyCodec === ZSTD_BODY_CODEC
        ? zstdDecompressSync(row.body).toString("utf8")
        : row.bodyCodec === IDENTITY_BODY_CODEC
          ? Buffer.from(row.body).toString("utf8")
          : undefined;
    if (message === undefined) {
        throw new Error(`Unsupported audit record body codec: ${row.bodyCodec}.`);
    }
    return {
        ...(payload as Record<string, unknown>),
        message,
    } as TRecord;
}

function decodedLogMessageBytes(record: unknown): number {
    if (typeof record !== "object" || record === null || Array.isArray(record)) return 0;
    const message = (record as { message?: unknown }).message;
    return typeof message === "string" ? Buffer.byteLength(message, "utf8") : 0;
}

function auditCollectionSql(collection: AuditRecordCollection): string {
    switch (collection) {
        case "approvals": return "'approvals'";
        case "events": return "'events'";
        case "logs": return "'logs'";
        case "toolCalls": return "'toolCalls'";
    }
}

function readPragmaNumber(
    database: DatabaseSync,
    name: "freelist_count" | "page_count" | "page_size" | "user_version",
): number {
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

function fileSize(path: string): number {
    try {
        return statSync(path).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return 0;
        }
        throw error;
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
