import { createRequire } from "node:module";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
    constants as zlibConstants,
    zstdCompress,
    zstdCompressSync,
    zstdDecompressSync,
} from "node:zlib";

import type { ToolCallQuery, ToolCallRecord } from "@portable-devshell/shared";
import type { AuditToolCallFailureSummary, InstanceLogEntry, LogQuery, StateStore } from "../Api.js";

import {
    startAuditPayloadBackfill,
    startAuditWalCheckpoint,
    type AuditBackgroundTask,
} from "./Background.js";
import type { AuditRecordStore, AuditSequenceStore } from "../RecordStore.js";
import { minimumAuditStorageBytes } from "./Limits.js";
import {
    assertSqliteSchemaVersionSupported,
    readSqlitePragmaNumber,
} from "./Schema.js";

export type AuditRecordCollection = "events" | "logs" | "toolCalls";

export interface AuditDatabaseOptions {
    maxBytes: number;
    now?: () => number;
    retentionDays: number;
}

export interface AuditStoreOptions<TRecord> {
    maxRecords?: number;
    sequence?: (record: TRecord) => number;
    timestamp: (record: TRecord) => number | string;
}

export interface AuditDatabaseStats {
    fileBytes: number;
    payloadBytes: number;
    recordCount: number;
}

export interface AuditToolCallRecordStore extends AuditRecordStore<ToolCallRecord> {
    hasCall(callId: string): boolean;
    readFailureSummary(
        sinceMs: number,
        untilMs: number,
    ): AuditToolCallFailureSummary;
    readQuery(query: ToolCallQuery): ToolCallRecord[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IDENTITY_BODY_CODEC = "identity";
const LOG_BODY_COMPRESSION_THRESHOLD_BYTES = 8 * 1024;
const LOG_BODY_COMPRESSION_SAMPLE_BYTES = 32 * 1024;
const LOG_BODY_SAMPLE_MAX_RATIO = 0.7;
const LOG_BODY_ASYNC_COMPRESSION_THRESHOLD_BYTES = 256 * 1024;
const PAYLOAD_BYTES_METADATA_KEY = "payloadBytes:v1";
const ROUTINE_INCREMENTAL_VACUUM_PAGES = 64;
export const AUDIT_DATABASE_SCHEMA_VERSION = 3;
const WAL_AUTOCHECKPOINT_PAGES = 0;
const WAL_CHECKPOINT_THRESHOLD_BYTES = 4 * 1024 * 1024;
const WAL_MINIMUM_WRITE_BYTES = 16 * 1024;
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
    #writeTail: Promise<void> = Promise.resolve();
    #closePromise?: Promise<void>;
    #payloadBackfill?: AuditBackgroundTask;
    #payloadBackfillBytes = 0;
    #payloadBackfillGeneration = 0;
    #payloadBytes?: number;
    #walCheckpoint?: AuditBackgroundTask;
    #walPendingBytes = 0;

    constructor(filePath: string, options: AuditDatabaseOptions) {
        validateOptions(options);
        this.#filePath = filePath;
        this.#maxBytes = options.maxBytes;
        this.#now = options.now ?? Date.now;
        this.#retentionMs = options.retentionDays * DAY_MS;
    }

    store<TRecord>(
        collection: AuditRecordCollection,
        options: AuditStoreOptions<TRecord>,
    ): AuditSequenceStore<TRecord> {
        this.#assertOpen();
        validateStoreOptions(options);
        return new AuditRecordStoreSqlite(this, collection, options);
    }

    stateStore<TValue>(namespace: string): StateStore<TValue> {
        this.#assertOpen();
        validateStateIdentifier("namespace", namespace);
        return {
            put: async (key, value) => {
                this.#assertAcceptingWrites();
                this.#putState(namespace, key, value);
                this.#scheduleWalCheckpoint();
            },
            get: async (key) => {
                validateStateIdentifier("key", key);
                const row = this.#database
                    .prepare(
                        "SELECT payload FROM state_records WHERE namespace = ? AND key = ?",
                    )
                    .get(namespace, key) as { payload: string } | undefined;
                return row === undefined
                    ? undefined
                    : (JSON.parse(row.payload) as TValue);
            },
            list: async () => {
                const rows = this.#database
                    .prepare(
                        "SELECT payload FROM state_records WHERE namespace = ? ORDER BY key ASC",
                    )
                    .all(namespace) as Array<{ payload: string }>;
                return rows.map((row) => JSON.parse(row.payload) as TValue);
            },
            delete: async (key) => {
                this.#assertAcceptingWrites();
                validateStateIdentifier("key", key);
                const removed = this.#database
                    .prepare(
                        "DELETE FROM state_records WHERE namespace = ? AND key = ?",
                    )
                    .run(namespace, key);
                if (removed.changes > 0) {
                    this.#walPendingBytes += WAL_MINIMUM_WRITE_BYTES;
                    this.#scheduleWalCheckpoint();
                }
            },
        };
    }

    #putState<TValue>(namespace: string, key: string, value: TValue): void {
        validateStateIdentifier("key", key);
        const payload = JSON.stringify(value);
        if (payload === undefined) {
            throw new TypeError(
                `State value for namespace ${namespace} and key ${key} is not JSON-serializable.`,
            );
        }
        const payloadBytes = Buffer.byteLength(payload, "utf8");
        this.#database
            .prepare(
                "INSERT INTO state_records(namespace, key, payload, payload_bytes) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET payload = excluded.payload, payload_bytes = excluded.payload_bytes",
            )
            .run(namespace, key, payload, payloadBytes);
        this.#walPendingBytes += Math.max(
            payloadBytes,
            WAL_MINIMUM_WRITE_BYTES,
        );
    }

    toolCallStore(
        options: AuditStoreOptions<ToolCallRecord>,
    ): AuditToolCallRecordStore {
        this.#assertOpen();
        return new AuditToolCallRecordStoreSqlite(this, options);
    }

    close(): Promise<void> {
        return (this.#closePromise ??= this.#writeTail.then(() => {
            this.#closed = true;
            this.#cancelPayloadBackfill();
            this.#cancelWalCheckpoint();
            const database = this.#databaseHandle;
            if (database !== undefined) {
                try {
                    this.#checkpointWal(true, database);
                } finally {
                    database.close();
                    this.#databaseHandle = undefined;
                }
            }
        }));
    }

    cleanup(): void {
        this.#assertOpen();
        this.#cancelWalCheckpoint();
        this.#ensurePayloadBytes();
        const cutoff = this.#now() - this.#retentionMs;
        const expired = this.#database
            .prepare("DELETE FROM audit_records WHERE occurred_at_ms < ?")
            .run(cutoff);
        if (expired.changes > 0) {
            this.#setPayloadBytes(this.#readPayloadBytes());
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
            payloadBytes: this.#payloadBytes ?? 0,
            recordCount: row.recordCount,
        };
    }

    appendRecord<TRecord>(
        collection: AuditRecordCollection,
        record: TRecord,
        options: AuditStoreOptions<TRecord>,
    ): Promise<void> {
        this.#assertAcceptingWrites();
        const write = this.#writeTail.then(async () => {
            if (options.maxRecords === undefined) this.#startPayloadBackfill();
            else this.#cancelPayloadBackfill();
            await this.#insertRecord(collection, record, options);
            if (options.maxRecords !== undefined) {
                this.#trimCollectionRecords(collection, options.maxRecords);
                if (this.#payloadBytes === undefined) this.#startPayloadBackfill();
            }
            this.#evictForPayloadLimit();
            this.#scheduleWalCheckpoint();
        });
        this.#writeTail = write.then(() => undefined, () => undefined);
        return write;
    }

    readRecords<TRecord>(collection: AuditRecordCollection): TRecord[] {
        this.#assertOpen();
        return (
            this.#database
                .prepare(
                    "SELECT payload, body, body_codec AS bodyCodec FROM audit_records WHERE collection = ? AND occurred_at_ms >= ? ORDER BY id ASC",
                )
                .all(
                    collection,
                    this.#retentionCutoff(),
                ) as unknown as AuditStoredRow[]
        ).map((row) => decodeStoredRecord<TRecord>(collection, row));
    }

    readTailRecords<TRecord>(
        collection: AuditRecordCollection,
        limit: number,
        maxDecodedBytes?: number,
    ): TRecord[] {
        this.#assertOpen();
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new TypeError(`Invalid audit tail limit: ${limit}`);
        }
        if (
            maxDecodedBytes !== undefined &&
            (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1)
        ) {
            throw new TypeError(
                `Invalid audit decoded byte limit: ${maxDecodedBytes}.`,
            );
        }
        const statement = this.#database.prepare(
            "SELECT payload, body, body_codec AS bodyCodec FROM audit_records WHERE collection = ? AND occurred_at_ms >= ? ORDER BY id DESC LIMIT ?",
        );
        const records: TRecord[] = [];
        let decodedBytes = 0;
        for (const value of statement.iterate(
            collection,
            this.#retentionCutoff(),
            limit,
        )) {
            const record = decodeStoredRecord<TRecord>(
                collection,
                value as unknown as AuditStoredRow,
            );
            records.push(record);
            if (collection === "logs" && maxDecodedBytes !== undefined) {
                decodedBytes += decodedLogMessageBytes(record);
                if (decodedBytes >= maxDecodedBytes) break;
            }
        }
        records.reverse();
        return records;
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
        if (
            limit !== undefined &&
            (!Number.isSafeInteger(limit) || limit < 1)
        ) {
            throw new TypeError(`Invalid audit sequence limit: ${limit}.`);
        }
        if (
            maxDecodedBytes !== undefined &&
            (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1)
        ) {
            throw new TypeError(
                `Invalid audit decoded byte limit: ${maxDecodedBytes}.`,
            );
        }
        const collectionSql = auditCollectionSql(collection);
        const statement = this.#database.prepare(
            `SELECT payload, body, body_codec AS bodyCodec FROM audit_records
             WHERE collection = ${collectionSql} AND occurred_at_ms >= ? AND json_extract(payload, '$.seq') >= ?
             ORDER BY id ASC${limit === undefined ? "" : " LIMIT ?"}`,
        );
        const parameters =
            limit === undefined
                ? [this.#retentionCutoff(), fromSeq]
                : [this.#retentionCutoff(), fromSeq, limit];
        const records: TRecord[] = [];
        let decodedBytes = 0;
        for (const value of statement.iterate(...parameters)) {
            const record = decodeStoredRecord<TRecord>(
                collection,
                value as unknown as AuditStoredRow,
            );
            records.push(record);
            if (collection === "logs" && maxDecodedBytes !== undefined) {
                decodedBytes += decodedLogMessageBytes(record);
                if (decodedBytes >= maxDecodedBytes) break;
            }
        }
        return records;
    }

    /** Bounded log lookup, indexed by ToolCall instead of scanning Instance history. */
    readCallLogRecords(query: LogQuery & { callId: string; ctxId: string }): InstanceLogEntry[] {
        this.#assertOpen();
        const fromSeq = query.fromSeq ?? 1;
        const limit = query.limit ?? 32;
        const maxDecodedBytes = query.maxDecodedBytes ?? 256 * 1024;
        if (!query.callId || query.callId.length > 256 || !query.ctxId || query.ctxId.length > 256 ||
            !Number.isSafeInteger(fromSeq) || fromSeq < 1 ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 128 ||
            !Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 ||
            maxDecodedBytes > 1024 * 1024)
            throw new TypeError("Invalid ToolCall log query.");
        const statement = this.#database.prepare(
            `SELECT payload, body, body_codec AS bodyCodec FROM audit_records
             WHERE collection = 'logs' AND occurred_at_ms >= ?
               AND json_extract(payload, '$.callId') = ?
               AND json_extract(payload, '$.ctxId') = ?
               AND json_extract(payload, '$.seq') >= ?
             ORDER BY id ASC LIMIT ?`,
        );
        const records: InstanceLogEntry[] = [];
        let decodedBytes = 0;
        for (const row of statement.iterate(this.#retentionCutoff(), query.callId,
            query.ctxId, fromSeq, limit)) {
            const record = decodeStoredRecord<InstanceLogEntry>("logs", row as unknown as AuditStoredRow);
            records.push(record);
            decodedBytes += Buffer.byteLength(record.message, "utf8");
            if (decodedBytes >= maxDecodedBytes) break;
        }
        return records;
    }

    readToolCallRecords(query: ToolCallQuery): ToolCallRecord[] {
        this.#assertOpen();
        if (
            query.limit !== undefined &&
            (!Number.isSafeInteger(query.limit) || query.limit < 1)
        ) {
            throw new TypeError(
                `Invalid audit tool-call limit: ${query.limit}.`,
            );
        }
        if (
            query.maxBytes !== undefined &&
            (!Number.isSafeInteger(query.maxBytes) || query.maxBytes < 1)
        ) {
            throw new TypeError(
                `Invalid audit tool-call maxBytes: ${query.maxBytes}.`,
            );
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
            predicates.push(
                `json_extract(payload, '$.callId') IN (${query.callIds.map(() => "?").join(", ")})`,
            );
            parameters.push(...query.callIds);
        }
        if (query.ctxId !== undefined) {
            predicates.push("json_extract(payload, '$.ctxId') = ?");
            parameters.push(query.ctxId);
        }
        if (query.workspace !== undefined) {
            predicates.push("json_extract(payload, '$.workspace') = ?");
            parameters.push(query.workspace);
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
        const payload = toolCallPayloadProjection(query);
        const statement = this.#database.prepare(
            `SELECT ${payload} AS payload FROM audit_records WHERE ${predicates.join(" AND ")} ORDER BY id ${newestFirst ? "DESC" : "ASC"}${limited ? " LIMIT ?" : ""}`,
        );
        const values = limited ? [...parameters, query.limit!] : parameters;
        const records: ToolCallRecord[] = [];
        let bytes = 2;
        for (const value of statement.iterate(...values)) {
            const row = value as { payload: string };
            if (query.maxBytes !== undefined) {
                const rowBytes =
                    Buffer.byteLength(row.payload, "utf8") +
                    (records.length === 0 ? 0 : 1);
                if (bytes + rowBytes > query.maxBytes) break;
                bytes += rowBytes;
            }
            records.push(JSON.parse(row.payload) as ToolCallRecord);
        }
        if (newestFirst) records.reverse();
        return records;
    }

    hasToolCallRecord(callId: string): boolean {
        this.#assertOpen();
        return this.#readToolCallId(callId) !== undefined;
    }

    readToolCallFailureSummary(
        sinceMs: number,
        untilMs: number,
    ): AuditToolCallFailureSummary {
        this.#assertOpen();
        if (
            !Number.isSafeInteger(sinceMs) ||
            !Number.isSafeInteger(untilMs) ||
            sinceMs > untilMs
        ) {
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
            .prepare(
                `SELECT COUNT(*) AS count FROM audit_records WHERE ${where}`,
            )
            .get(effectiveSinceMs, untilMs) as { count: number };
        if (count.count === 0) return { count: 0 };
        const latest = this.#database
            .prepare(
                `SELECT payload FROM audit_records WHERE ${where} ORDER BY occurred_at_ms DESC, id DESC LIMIT 1`,
            )
            .get(effectiveSinceMs, untilMs) as { payload: string } | undefined;
        return {
            count: count.count,
            ...(latest === undefined
                ? {}
                : { latest: JSON.parse(latest.payload) as ToolCallRecord }),
        };
    }

    readHighWater(collection: AuditRecordCollection): number {
        this.#assertOpen();
        const value = this.#readMetadata(`highWater:${collection}`);
        return value === undefined ? 0 : Number(value);
    }

    #trimCollectionRecords(
        collection: AuditRecordCollection,
        maxRecords: number,
    ): void {
        const boundary = this.#database
            .prepare(
                "SELECT id FROM audit_records WHERE collection = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
            )
            .get(collection, maxRecords) as { id: number } | undefined;
        if (boundary === undefined) return;
        const removed = this.#database
            .prepare(
                "SELECT COALESCE(SUM(payload_bytes), 0) AS payloadBytes FROM audit_records WHERE collection = ? AND id <= ?",
            )
            .get(collection, boundary.id) as { payloadBytes: number };
        this.#database
            .prepare(
                "DELETE FROM audit_records WHERE collection = ? AND id <= ?",
            )
            .run(collection, boundary.id);
        if (this.#payloadBytes !== undefined) {
            this.#setPayloadBytes(
                Math.max(0, this.#payloadBytes - removed.payloadBytes),
            );
        }
    }

    #initializeSchema(): void {
        this.#database.exec("PRAGMA journal_mode = WAL");
        this.#database.exec("PRAGMA synchronous = NORMAL");
        this.#database.exec(
            `PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`,
        );
        this.#database.exec(
            `PRAGMA journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`,
        );
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
            CREATE INDEX IF NOT EXISTS audit_records_tool_call_workspace
                ON audit_records(json_extract(payload, '$.workspace'), id)
                WHERE collection = 'toolCalls';
            CREATE INDEX IF NOT EXISTS audit_records_log_sequence
                ON audit_records(json_extract(payload, '$.seq'), id)
                WHERE collection = 'logs';
            CREATE INDEX IF NOT EXISTS audit_records_log_call_id
                ON audit_records(json_extract(payload, '$.callId'), json_extract(payload, '$.seq'), id)
                WHERE collection = 'logs';
            CREATE INDEX IF NOT EXISTS audit_records_event_sequence
                ON audit_records(json_extract(payload, '$.seq'), id)
                WHERE collection = 'events';
            CREATE TABLE IF NOT EXISTS state_records (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                payload TEXT NOT NULL,
                payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                PRIMARY KEY(namespace, key)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS audit_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
        `);
        this.#database.exec(`PRAGMA user_version = ${AUDIT_DATABASE_SCHEMA_VERSION}`);
    }

    async #insertRecord<TRecord>(
        collection: AuditRecordCollection,
        record: TRecord,
        options: AuditStoreOptions<TRecord>,
    ): Promise<void> {
        const stored = await encodeStoredRecord(collection, record);
        this.#insertStoredRecord(collection, record, options, stored);
    }

    #insertStoredRecord<TRecord>(
        collection: AuditRecordCollection,
        record: TRecord,
        options: AuditStoreOptions<TRecord>,
        stored: AuditStoredRow & { payloadBytes: number },
    ): void {
        const occurredAtMs = normalizeTimestamp(options.timestamp(record));
        this.#database
            .prepare(
                "INSERT INTO audit_records(collection, occurred_at_ms, payload_bytes, payload, body, body_codec) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
                collection,
                occurredAtMs,
                stored.payloadBytes,
                stored.payload,
                stored.body,
                stored.bodyCodec,
            );
        if (this.#payloadBytes !== undefined) {
            this.#setPayloadBytes(this.#payloadBytes + stored.payloadBytes);
        } else if (this.#payloadBackfill !== undefined) {
            this.#payloadBackfillBytes += stored.payloadBytes;
        }
        this.#walPendingBytes += Math.max(
            stored.payloadBytes,
            WAL_MINIMUM_WRITE_BYTES,
        );

        const sequence = options.sequence?.(record);
        if (sequence !== undefined) {
            if (!Number.isSafeInteger(sequence) || sequence < 0) {
                throw new TypeError(
                    `Invalid ${collection} sequence: ${sequence}`,
                );
            }
            const current = this.readHighWater(collection);
            if (sequence > current) {
                this.#writeMetadata(
                    `highWater:${collection}`,
                    String(sequence),
                );
            }
        }
    }

    #readPayloadBytes(): number {
        const row = this.#database
            .prepare(
                "SELECT COALESCE(SUM(payload_bytes), 0) AS payloadBytes FROM audit_records",
            )
            .get() as { payloadBytes: number };
        return row.payloadBytes;
    }

    #ensurePayloadBytes(): number {
        const current = this.#payloadBytes;
        if (current !== undefined) return current;
        this.#cancelPayloadBackfill();
        const rebuilt = this.#readPayloadBytes();
        this.#setPayloadBytes(rebuilt);
        return rebuilt;
    }

    #startPayloadBackfill(): void {
        if (
            this.#payloadBytes !== undefined ||
            this.#payloadBackfill !== undefined
        )
            return;
        const highWaterRow = this.#database
            .prepare("SELECT id FROM audit_records ORDER BY id DESC LIMIT 1")
            .get() as { id: number } | undefined;
        const highWater = highWaterRow?.id ?? 0;
        const generation = ++this.#payloadBackfillGeneration;
        this.#payloadBackfillBytes = 0;
        try {
            this.#payloadBackfill = startAuditPayloadBackfill(
                this.#filePath,
                highWater,
                (historicalBytes) => {
                    if (
                        this.#closed ||
                        generation !== this.#payloadBackfillGeneration
                    )
                        return;
                    const payloadBytes =
                        historicalBytes + this.#payloadBackfillBytes;
                    this.#payloadBackfill = undefined;
                    this.#payloadBackfillBytes = 0;
                    this.#setPayloadBytes(payloadBytes);
                    this.#evictForPayloadLimit();
                    this.#scheduleWalCheckpoint();
                },
                () => {
                    if (generation !== this.#payloadBackfillGeneration) return;
                    this.#payloadBackfill = undefined;
                    this.#payloadBackfillBytes = 0;
                    this.#scheduleWalCheckpoint();
                },
            );
        } catch {
            this.#payloadBackfill = undefined;
            this.#payloadBackfillBytes = 0;
        }
    }

    #cancelPayloadBackfill(): void {
        const backfill = this.#payloadBackfill;
        if (backfill === undefined) return;
        this.#payloadBackfillGeneration += 1;
        this.#payloadBackfill = undefined;
        this.#payloadBackfillBytes = 0;
        backfill.cancel();
    }

    #scheduleWalCheckpoint(): void {
        if (
            this.#closed ||
            this.#payloadBackfill !== undefined ||
            this.#walCheckpoint !== undefined ||
            this.#walPendingBytes <= WAL_CHECKPOINT_THRESHOLD_BYTES
        ) {
            return;
        }
        const checkpointBytes = this.#walPendingBytes;
        this.#walPendingBytes = 0;
        let checkpoint: AuditBackgroundTask | undefined;
        const completed = (checkpointComplete: boolean): void => {
            if (this.#walCheckpoint !== checkpoint) return;
            this.#walCheckpoint = undefined;
            if (!checkpointComplete) this.#walPendingBytes += checkpointBytes;
            if (
                checkpointComplete &&
                this.#walPendingBytes > WAL_CHECKPOINT_THRESHOLD_BYTES
            ) {
                this.#scheduleWalCheckpoint();
            }
        };
        const failed = (): void => {
            if (this.#walCheckpoint !== checkpoint) return;
            this.#walCheckpoint = undefined;
            this.#walPendingBytes += checkpointBytes;
        };
        try {
            checkpoint = startAuditWalCheckpoint(
                this.#filePath,
                completed,
                failed,
            );
            this.#walCheckpoint = checkpoint;
        } catch {
            this.#walPendingBytes += checkpointBytes;
            this.#walCheckpoint = undefined;
        }
    }

    #cancelWalCheckpoint(): void {
        const checkpoint = this.#walCheckpoint;
        if (checkpoint === undefined) return;
        this.#walCheckpoint = undefined;
        checkpoint.cancel();
    }

    #setPayloadBytes(value: number): void {
        this.#payloadBytes = value;
        this.#writeMetadata(PAYLOAD_BYTES_METADATA_KEY, String(value));
    }

    #readToolCallId(callId: string): number | undefined {
        const row = this.#database
            .prepare(
                "SELECT id FROM audit_records WHERE collection = 'toolCalls' AND occurred_at_ms >= ? AND json_extract(payload, '$.callId') = ? ORDER BY id DESC LIMIT 1",
            )
            .get(this.#retentionCutoff(), callId) as { id: number } | undefined;
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
        if (payloadBytes === undefined) return;
        if (payloadBytes <= this.#maxBytes) {
            return;
        }
        const rows = this.#database
            .prepare(
                "SELECT id, payload_bytes AS payloadBytes FROM audit_records ORDER BY id ASC LIMIT 256",
            )
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
            this.#database
                .prepare("DELETE FROM audit_records WHERE id <= ?")
                .run(cutoffId);
            this.#setPayloadBytes(payloadBytes);
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
                .prepare(
                    "SELECT id, payload_bytes AS payloadBytes FROM audit_records ORDER BY id ASC LIMIT 256",
                )
                .all() as Array<{ id: number; payloadBytes: number }>;
            if (rows.length === 0) {
                this.#database.exec("VACUUM");
                this.#checkpointWal(true);
                if (this.#fileBytes() > this.#maxBytes) {
                    throw new Error(
                        `audit database cannot fit within maxBytes=${this.#maxBytes}`,
                    );
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
            this.#database
                .prepare("DELETE FROM audit_records WHERE id <= ?")
                .run(cutoffId);
            if (this.#payloadBytes !== undefined) {
                this.#setPayloadBytes(
                    Math.max(0, this.#payloadBytes - evictedPayloadBytes),
                );
            }
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
        const freelist = readSqlitePragmaNumber(
            this.#database,
            "freelist_count",
        );
        if (freelist > 0) {
            const pages = aggressive
                ? freelist
                : Math.min(freelist, ROUTINE_INCREMENTAL_VACUUM_PAGES);
            this.#database.exec(`PRAGMA incremental_vacuum(${pages})`);
        }
    }

    #checkpointWal(
        truncate: boolean,
        database: DatabaseSync = this.#database,
    ): void {
        database.exec(
            `PRAGMA wal_checkpoint(${truncate ? "TRUNCATE" : "PASSIVE"})`,
        );
        if (database === this.#databaseHandle) this.#walPendingBytes = 0;
    }

    #readMetadata(key: string): string | undefined {
        const row = this.#database
            .prepare("SELECT value FROM audit_metadata WHERE key = ?")
            .get(key) as { value: string } | undefined;
        return row?.value;
    }

    #writeMetadata(key: string, value: string): void {
        this.#database
            .prepare(
                "INSERT INTO audit_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
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
            const userVersion = assertSqliteSchemaVersionSupported(database, {
                databaseLabel: "Audit database",
                filePath: this.#filePath,
                supportedVersion: AUDIT_DATABASE_SCHEMA_VERSION,
            });
            const hasAuditTable = database.prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_records'",
            ).get() !== undefined;
            if (userVersion === 0 && hasAuditTable) {
                throw new Error("Unversioned audit database is unsupported. The database was not modified.");
            }
            if (userVersion === AUDIT_DATABASE_SCHEMA_VERSION) {
                const columns = new Set(
                    (database.prepare("PRAGMA table_info(audit_records)").all() as Array<{ name: string }>)
                        .map((column) => column.name),
                );
                if (!columns.has("body") || !columns.has("body_codec")) {
                    throw new Error("Audit database schema is inconsistent: body columns are missing. The database was not modified.");
                }
            }
            this.#initializeSchema();
            const storedPayloadBytes = this.#readMetadata(
                PAYLOAD_BYTES_METADATA_KEY,
            );
            if (
                storedPayloadBytes !== undefined &&
                /^\d+$/u.test(storedPayloadBytes)
            ) {
                this.#payloadBytes = Number(storedPayloadBytes);
            } else {
                const hasRecords =
                    this.#database
                        .prepare(
                            "SELECT 1 AS present FROM audit_records LIMIT 1",
                        )
                        .get() !== undefined;
                if (!hasRecords) this.#setPayloadBytes(0);
            }
            this.#walPendingBytes = fileSize(`${this.#filePath}-wal`);
            return database;
        } catch (error) {
            this.#databaseHandle = undefined;
            database.close();
            throw error;
        }
    }

    #assertAcceptingWrites(): void {
        this.#assertOpen();
        if (this.#closePromise !== undefined) {
            throw new Error("SQLite audit database is closing.");
        }
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new Error("SQLite audit database is closed.");
        }
    }
}

class AuditRecordStoreSqlite<TRecord> implements AuditSequenceStore<TRecord> {
    constructor(
        readonly database: AuditDatabase,
        readonly collection: AuditRecordCollection,
        readonly options: AuditStoreOptions<TRecord>,
    ) {}

    append(record: TRecord): Promise<void> {
        return this.database.appendRecord(this.collection, record, this.options);
    }

    readAll(): TRecord[] {
        return this.database.readRecords<TRecord>(this.collection);
    }

    readFromSeq(fromSeq: number, limit?: number, maxDecodedBytes?: number): TRecord[] {
        return this.database.readSequenceRecords<TRecord>(
            this.collection, fromSeq, limit, maxDecodedBytes,
        );
    }

    readHighWater(): number {
        return this.database.readHighWater(this.collection);
    }

    readTail(limit: number, maxDecodedBytes?: number): TRecord[] {
        return this.database.readTailRecords<TRecord>(this.collection, limit, maxDecodedBytes);
    }
}

class AuditToolCallRecordStoreSqlite implements AuditToolCallRecordStore {
    constructor(
        readonly database: AuditDatabase,
        readonly options: AuditStoreOptions<ToolCallRecord>,
    ) {}

    append(record: ToolCallRecord): Promise<void> {
        return this.database.appendRecord("toolCalls", record, this.options);
    }

    hasCall(callId: string): boolean {
        return this.database.hasToolCallRecord(callId);
    }

    readAll(): ToolCallRecord[] {
        return this.database.readRecords<ToolCallRecord>("toolCalls");
    }

    readQuery(query: ToolCallQuery): ToolCallRecord[] {
        return this.database.readToolCallRecords(query);
    }

    readFailureSummary(sinceMs: number, untilMs: number): AuditToolCallFailureSummary {
        return this.database.readToolCallFailureSummary(sinceMs, untilMs);
    }
}

function normalizeTimestamp(value: number | string): number {
    const parsed = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isSafeInteger(parsed)) throw new TypeError("Invalid audit record timestamp.");
    return parsed;
}

async function encodeStoredRecord<TRecord>(
    collection: AuditRecordCollection,
    record: TRecord,
): Promise<AuditStoredRow & { payloadBytes: number }> {
    if (
        collection !== "logs" ||
        typeof record !== "object" ||
        record === null ||
        Array.isArray(record)
    ) {
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
    const sample = message.subarray(
        0,
        Math.min(message.byteLength, LOG_BODY_COMPRESSION_SAMPLE_BYTES),
    );
    const compressedSample = compressLogBody(sample);
    if (
        compressedSample.byteLength / sample.byteLength >
        LOG_BODY_SAMPLE_MAX_RATIO
    ) {
        return bodyStoredRecord(payload, message, IDENTITY_BODY_CODEC);
    }

    const compressed =
        message.byteLength >= LOG_BODY_ASYNC_COMPRESSION_THRESHOLD_BYTES
            ? await compressLogBodyAsync(message)
            : compressLogBody(message);
    if (compressed.byteLength >= message.byteLength) {
        return bodyStoredRecord(payload, message, IDENTITY_BODY_CODEC);
    }
    return bodyStoredRecord(payload, compressed, ZSTD_BODY_CODEC);
}


function bodyStoredRecord(
    payload: string,
    body: Uint8Array,
    bodyCodec: string,
): AuditStoredRow & { payloadBytes: number } {
    return {
        body,
        bodyCodec,
        payload,
        payloadBytes: Buffer.byteLength(payload, "utf8") + body.byteLength,
    };
}

function compressLogBody(body: Uint8Array): Buffer {
    return zstdCompressSync(body, {
        params: {
            [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL,
        },
    });
}

function compressLogBodyAsync(body: Uint8Array): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        zstdCompress(
            body,
            {
                params: {
                    [zlibConstants.ZSTD_c_compressionLevel]:
                        ZSTD_COMPRESSION_LEVEL,
                },
            },
            (error, compressed) => {
                if (error !== null) reject(error);
                else resolve(compressed);
            },
        );
    });
}

function inlineStoredRecord(
    payload: string,
): AuditStoredRow & { payloadBytes: number } {
    return {
        body: null,
        bodyCodec: null,
        payload,
        payloadBytes: Buffer.byteLength(payload, "utf8"),
    };
}

function decodeStoredRecord<TRecord>(
    collection: string,
    row: AuditStoredRow,
): TRecord {
    const payload = JSON.parse(row.payload) as unknown;
    if (row.bodyCodec === null) {
        if (row.body !== null) {
            throw new Error("Audit record has a body without a codec.");
        }
        return payload as TRecord;
    }
    if (collection !== "logs" || row.body === null) {
        throw new Error(
            `Unsupported audit record body codec: ${row.bodyCodec}.`,
        );
    }
    if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
    ) {
        throw new Error("Externalized audit log metadata must be an object.");
    }
    const message =
        row.bodyCodec === ZSTD_BODY_CODEC
            ? zstdDecompressSync(row.body).toString("utf8")
            : row.bodyCodec === IDENTITY_BODY_CODEC
              ? Buffer.from(row.body).toString("utf8")
              : undefined;
    if (message === undefined) {
        throw new Error(
            `Unsupported audit record body codec: ${row.bodyCodec}.`,
        );
    }
    return {
        ...(payload as Record<string, unknown>),
        message,
    } as TRecord;
}

function decodedLogMessageBytes(record: unknown): number {
    if (typeof record !== "object" || record === null || Array.isArray(record))
        return 0;
    const message = (record as { message?: unknown }).message;
    return typeof message === "string" ? Buffer.byteLength(message, "utf8") : 0;
}

function auditCollectionSql(collection: AuditRecordCollection): string {
    switch (collection) {
        case "events":
            return "'events'";
        case "logs":
            return "'logs'";
        case "toolCalls":
            return "'toolCalls'";
    }
}

function validateOptions(options: AuditDatabaseOptions): void {
    if (
        !Number.isSafeInteger(options.maxBytes) ||
        options.maxBytes < minimumAuditStorageBytes
    ) {
        throw new TypeError(
            `maxBytes must be an integer of at least ${minimumAuditStorageBytes}.`,
        );
    }
    if (
        !Number.isSafeInteger(options.retentionDays) ||
        options.retentionDays < 1
    ) {
        throw new TypeError("retentionDays must be a positive safe integer.");
    }
}

function validateStoreOptions<TRecord>(
    options: AuditStoreOptions<TRecord>,
): void {
    if (
        options.maxRecords !== undefined &&
        (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1)
    ) {
        throw new TypeError(
            "maxRecords must be a positive safe integer when provided.",
        );
    }
}

function validateStateIdentifier(
    kind: "key" | "namespace",
    value: string,
): void {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`State ${kind} must be a non-empty string.`);
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

function toolCallPayloadProjection(query: ToolCallQuery): string {
    if (query.includeInput === false && query.includeOutput === false) {
        return "json_remove(payload, '$.input', '$.output')";
    }
    if (query.includeInput === false) {
        return "json_remove(payload, '$.input')";
    }
    if (query.includeOutput === false) {
        return "json_remove(payload, '$.output')";
    }
    return "payload";
}

function loadDatabaseSync(): typeof import("node:sqlite").DatabaseSync {
    const require = createRequire(import.meta.url);
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
        const message = warning instanceof Error ? warning.message : warning;
        const type =
            typeof args[0] === "string"
                ? args[0]
                : typeof args[0] === "object" &&
                    args[0] !== null &&
                    "type" in args[0]
                  ? String((args[0] as { type?: unknown }).type)
                  : undefined;
        if (type === "ExperimentalWarning" && message.includes("SQLite")) {
            return;
        }
        Reflect.apply(originalEmitWarning, process, [warning, ...args]);
    }) as typeof process.emitWarning;
    try {
        return (require("node:sqlite") as typeof import("node:sqlite"))
            .DatabaseSync;
    } finally {
        process.emitWarning = originalEmitWarning;
    }
}
