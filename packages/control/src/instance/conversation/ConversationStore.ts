import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { assertSqliteSchemaVersionSupported } from "@portable-devshell/core";
import type {
    ContextMessageListInput,
    ContextMessageRecord,
    ConversationEntry,
    ConversationEntryKind,
    ConversationListInput,
} from "@portable-devshell/shared";

import { ContextMessageState } from "../context/ContextMessageState.js";

export const CONVERSATION_DATABASE_SCHEMA_VERSION = 1;
export const defaultConversationStorageLimits = {
    maxBytes: 512 * 1024 * 1024,
    retentionDays: 90,
} as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const LEGACY_COMMENT_MIGRATION_KEY = "migration:context-messages-json-v1";
const LEGACY_REPORT_MIGRATION_KEY = "migration:todo-report-audit-v1";

export interface ConversationStoreStats {
    comments: number;
    entries: number;
    fileBytes: number;
    maxBytes: number;
    payloadBytes: number;
    protectedComments: number;
    reports: number;
    retentionDays: number;
}

interface ConversationRow {
    callId: string | null;
    createdAt: string;
    ctxId: string;
    deliveredAt: string | null;
    error: string | null;
    failedAt: string | null;
    id: string;
    kind: ConversationEntryKind;
    seq: number;
    status: ContextMessageRecord["status"] | null;
    text: string;
}

export class ConversationStore {
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #legacyContextMessagesFile?: string;
    readonly #maxBytes: number;
    readonly #now: () => number;
    readonly #retentionDays: number;
    readonly #retentionMs: number;
    #database?: DatabaseSync;
    #lastRetentionCleanupAt = Number.NEGATIVE_INFINITY;
    #payloadBytes?: number;

    constructor(options: {
        filePath: string;
        instanceName: string;
        legacyContextMessagesFile?: string;
        maxBytes?: number;
        now?: () => number;
        retentionDays?: number;
    }) {
        const maxBytes = options.maxBytes ?? defaultConversationStorageLimits.maxBytes;
        const retentionDays = options.retentionDays ?? defaultConversationStorageLimits.retentionDays;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
            throw new TypeError("Conversation maxBytes must be a positive safe integer.");
        }
        if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
            throw new TypeError("Conversation retentionDays must be a positive safe integer.");
        }
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#legacyContextMessagesFile = options.legacyContextMessagesFile;
        this.#maxBytes = maxBytes;
        this.#now = options.now ?? Date.now;
        this.#retentionDays = retentionDays;
        this.#retentionMs = retentionDays * DAY_MS;
    }

    close(): void {
        this.#database?.close();
        this.#database = undefined;
        this.#lastRetentionCleanupAt = Number.NEGATIVE_INFINITY;
        this.#payloadBytes = undefined;
    }

    list(input: ConversationListInput = {}): ConversationEntry[] {
        this.#cleanup(this.#open());
        return applyByteBudget(
            this.#listRows(input, undefined).map(toConversationEntry),
            input.maxBytes,
        );
    }

    listComments(input: ContextMessageListInput = {}): ContextMessageRecord[] {
        this.#cleanup(this.#open());
        const entries = this.#listRows(input, "comment").map((row) => toContextMessageRecord(row, this.#instanceName));
        return applyByteBudget(entries, input.maxBytes);
    }

    pendingComments(ctxId?: string): ContextMessageRecord[] {
        const database = this.#open();
        const rows = database.prepare(`
            SELECT
                call_id AS callId,
                created_at AS createdAt,
                ctx_id AS ctxId,
                delivered_at AS deliveredAt,
                error,
                failed_at AS failedAt,
                id,
                kind,
                seq,
                status,
                text
            FROM conversation_entries
            WHERE kind = 'comment'
              AND status IN ('pending', 'sent')
              ${ctxId === undefined ? "" : "AND ctx_id = ?"}
            ORDER BY created_at ASC, seq ASC
        `).all(...(ctxId === undefined ? [] : [ctxId])) as unknown as ConversationRow[];
        return rows.map((row) => toContextMessageRecord(row, this.#instanceName));
    }

    insertComment(record: ContextMessageRecord): void {
        const database = this.#open();
        database.prepare(`
            INSERT INTO conversation_entries(
                kind, id, ctx_id, created_at, text, status, call_id, delivered_at, failed_at, error
            ) VALUES ('comment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            record.id,
            record.ctxId,
            record.createdAt,
            record.text,
            record.status,
            record.callId ?? null,
            record.deliveredAt ?? null,
            record.failedAt ?? null,
            record.error ?? null,
        );
        this.#payloadBytes = this.#trackedPayloadBytes() + this.#readEntryPayloadBytes(database, "comment", record.id);
        this.#cleanup(database, record.status === "delivered" || record.status === "failed");
    }

    deliverComments(ctxId: string, callId: string, deliveredAt: string): ContextMessageRecord[] {
        const database = this.#open();
        let pending: ContextMessageRecord[] = [];
        let beforePayloadBytes = 0;
        database.exec("BEGIN IMMEDIATE");
        try {
            pending = this.pendingComments(ctxId);
            if (pending.length === 0) {
                database.exec("COMMIT");
                return [];
            }
            beforePayloadBytes = pending.reduce(
                (total, record) => total + this.#readEntryPayloadBytes(database, "comment", record.id),
                0,
            );
            const update = database.prepare(`
                UPDATE conversation_entries
                SET status = 'delivered', call_id = ?, delivered_at = ?, failed_at = NULL, error = NULL
                WHERE kind = 'comment' AND id = ?
            `);
            for (const record of pending) update.run(callId, deliveredAt, record.id);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        const afterPayloadBytes = pending.reduce(
            (total, record) => total + this.#readEntryPayloadBytes(database, "comment", record.id),
            0,
        );
        this.#payloadBytes = this.#trackedPayloadBytes() + afterPayloadBytes - beforePayloadBytes;
        this.#cleanup(database, true);
        return pending.map((record) => ({
            ...record,
            callId,
            deliveredAt,
            error: undefined,
            failedAt: undefined,
            status: "delivered" as const,
        }));
    }

    failComments(ids: ReadonlySet<string>, error: string, failedAt: string): void {
        if (ids.size === 0) return;
        const database = this.#open();
        const beforePayloadBytes = [...ids].reduce(
            (total, id) => total + this.#readEntryPayloadBytes(database, "comment", id),
            0,
        );
        database.exec("BEGIN IMMEDIATE");
        try {
            const update = database.prepare(`
                UPDATE conversation_entries
                SET status = 'failed', delivered_at = NULL, failed_at = ?, error = ?
                WHERE kind = 'comment' AND id = ?
            `);
            for (const id of ids) update.run(failedAt, error, id);
            database.exec("COMMIT");
        } catch (cause) {
            database.exec("ROLLBACK");
            throw cause;
        }
        const afterPayloadBytes = [...ids].reduce(
            (total, id) => total + this.#readEntryPayloadBytes(database, "comment", id),
            0,
        );
        this.#payloadBytes = this.#trackedPayloadBytes() + afterPayloadBytes - beforePayloadBytes;
        this.#cleanup(database, true);
    }

    appendReport(input: { callId: string; createdAt: string; ctxId: string; text: string }): void {
        const database = this.#open();
        const result = database.prepare(`
            INSERT INTO conversation_entries(kind, id, ctx_id, created_at, text, call_id)
            VALUES ('report', ?, ?, ?, ?, ?)
            ON CONFLICT(kind, id) DO NOTHING
        `).run(input.callId, input.ctxId, input.createdAt, input.text, input.callId);
        if (Number(result.changes) > 0) {
            this.#payloadBytes = this.#trackedPayloadBytes() + this.#readEntryPayloadBytes(database, "report", input.callId);
        }
        this.#cleanup(database, true);
    }

    stats(): ConversationStoreStats {
        const database = this.#open();
        this.#cleanup(database);
        const row = database.prepare(`
            SELECT
                COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN kind = 'comment' THEN 1 ELSE 0 END), 0) AS comments,
                COALESCE(SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END), 0) AS reports,
                COALESCE(SUM(CASE WHEN kind = 'comment' AND status IN ('pending', 'sent') THEN 1 ELSE 0 END), 0) AS protectedComments
            FROM conversation_entries
        `).get() as {
            comments: number;
            entries: number;
            protectedComments: number;
            reports: number;
        };
        return {
            comments: row.comments,
            entries: row.entries,
            fileBytes: fileSize(this.#filePath) + fileSize(`${this.#filePath}-wal`),
            maxBytes: this.#maxBytes,
            payloadBytes: this.#trackedPayloadBytes(),
            protectedComments: row.protectedComments,
            reports: row.reports,
            retentionDays: this.#retentionDays,
        };
    }

    isLegacyReportMigrationComplete(): boolean {
        return this.#readMetadata(LEGACY_REPORT_MIGRATION_KEY) === "complete";
    }

    completeLegacyReportMigration(): void {
        this.#writeMetadata(LEGACY_REPORT_MIGRATION_KEY, "complete");
    }

    #listRows(
        input: Pick<ConversationListInput, "before" | "ctxId" | "limit">,
        kind: ConversationEntryKind | undefined,
    ): ConversationRow[] {
        const database = this.#open();
        const predicates: string[] = [];
        const parameters: Array<number | string> = [];
        if (kind !== undefined) {
            predicates.push("kind = ?");
            parameters.push(kind);
        }
        if (input.ctxId !== undefined) {
            predicates.push("ctx_id = ?");
            parameters.push(input.ctxId);
        }
        if (input.before !== undefined) {
            const boundary = database.prepare(`
                SELECT created_at AS createdAt, id, kind, seq
                FROM conversation_entries
                WHERE id = ? ${kind === undefined ? "" : "AND kind = ?"}
                ORDER BY created_at ASC, seq ASC
                LIMIT 1
            `).get(input.before, ...(kind === undefined ? [] : [kind])) as
                | { createdAt: string; id: string; kind: ConversationEntryKind; seq: number }
                | undefined;
            if (boundary !== undefined) {
                predicates.push("(created_at < ? OR (created_at = ? AND seq < ?))");
                parameters.push(boundary.createdAt, boundary.createdAt, boundary.seq);
            }
        }
        const limit = input.limit === undefined ? undefined : Math.max(1, Math.trunc(input.limit));
        const rows = database.prepare(`
            SELECT
                call_id AS callId,
                created_at AS createdAt,
                ctx_id AS ctxId,
                delivered_at AS deliveredAt,
                error,
                failed_at AS failedAt,
                id,
                kind,
                seq,
                status,
                text
            FROM conversation_entries
            ${predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`}
            ORDER BY created_at DESC, seq DESC
            ${limit === undefined ? "" : "LIMIT ?"}
        `).all(...(limit === undefined ? parameters : [...parameters, limit])) as unknown as ConversationRow[];
        return rows.reverse();
    }

    #open(): DatabaseSync {
        if (this.#database !== undefined) return this.#database;
        mkdirSync(dirname(this.#filePath), { recursive: true });
        const require = createRequire(import.meta.url);
        const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
        const database = new DatabaseSync(this.#filePath, { timeout: 5_000 });
        try {
            const userVersion = assertSqliteSchemaVersionSupported(database, {
                databaseLabel: "Conversation database",
                filePath: this.#filePath,
                supportedVersion: CONVERSATION_DATABASE_SCHEMA_VERSION,
            });
            this.#initializeSchema(database, userVersion);
            database.exec("PRAGMA journal_mode = WAL");
            database.exec("PRAGMA synchronous = NORMAL");
            this.#database = database;
            this.#migrateLegacyComments();
            this.#payloadBytes = this.#readPayloadBytes(database);
            this.#cleanup(database, true);
            return database;
        } catch (error) {
            this.#database = undefined;
            database.close();
            throw error;
        }
    }

    #initializeSchema(database: DatabaseSync, userVersion: number): void {
        if (userVersion === CONVERSATION_DATABASE_SCHEMA_VERSION) {
            const present = database.prepare(
                "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_entries'"
            ).get() !== undefined;
            if (!present) {
                throw new Error(
                    `Conversation database schema version ${CONVERSATION_DATABASE_SCHEMA_VERSION} is inconsistent: ` +
                    "conversation_entries is missing. Refusing to modify the database."
                );
            }
            return;
        }
        database.exec("BEGIN IMMEDIATE");
        try {
            database.exec(`
                CREATE TABLE IF NOT EXISTS conversation_entries (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL CHECK(kind IN ('comment', 'report')),
                    id TEXT NOT NULL,
                    ctx_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    text TEXT NOT NULL,
                    status TEXT CHECK(status IS NULL OR status IN ('pending', 'sent', 'delivered', 'failed')),
                    call_id TEXT,
                    delivered_at TEXT,
                    failed_at TEXT,
                    error TEXT,
                    UNIQUE(kind, id)
                ) STRICT;
                CREATE INDEX IF NOT EXISTS conversation_entries_context_time
                    ON conversation_entries(ctx_id, created_at, seq);
                CREATE INDEX IF NOT EXISTS conversation_entries_call
                    ON conversation_entries(call_id)
                    WHERE call_id IS NOT NULL;
                CREATE TABLE IF NOT EXISTS conversation_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                ) STRICT;
                PRAGMA user_version = ${CONVERSATION_DATABASE_SCHEMA_VERSION};
            `);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
    }

    #cleanup(database: DatabaseSync, forceRetention = false): void {
        const now = this.#now();
        let removed = false;
        if (forceRetention || now - this.#lastRetentionCleanupAt >= RETENTION_CLEANUP_INTERVAL_MS) {
            const cutoff = new Date(now - this.#retentionMs).toISOString();
            const expired = database.prepare(`
                SELECT COUNT(*) AS entries, COALESCE(SUM(${conversationPayloadBytesSql()}), 0) AS payloadBytes
                FROM conversation_entries
                WHERE
                    (kind = 'report' AND created_at < ?)
                    OR (
                        kind = 'comment'
                        AND status IN ('delivered', 'failed')
                        AND COALESCE(delivered_at, failed_at, created_at) < ?
                    )
            `).get(cutoff, cutoff) as { entries: number; payloadBytes: number };
            if (expired.entries > 0) {
                database.prepare(`
                    DELETE FROM conversation_entries
                    WHERE
                        (kind = 'report' AND created_at < ?)
                        OR (
                            kind = 'comment'
                            AND status IN ('delivered', 'failed')
                            AND COALESCE(delivered_at, failed_at, created_at) < ?
                        )
                `).run(cutoff, cutoff);
                this.#payloadBytes = Math.max(0, this.#trackedPayloadBytes() - expired.payloadBytes);
                removed = true;
            }
            this.#lastRetentionCleanupAt = now;
        }

        while (this.#trackedPayloadBytes() > this.#maxBytes) {
            const candidates = database.prepare(`
                SELECT seq, ${conversationPayloadBytesSql()} AS payloadBytes
                FROM conversation_entries
                WHERE kind = 'report' OR (kind = 'comment' AND status IN ('delivered', 'failed'))
                ORDER BY
                    CASE
                        WHEN kind = 'report' THEN created_at
                        ELSE COALESCE(delivered_at, failed_at, created_at)
                    END ASC,
                    seq ASC
                LIMIT 256
            `).all() as Array<{ payloadBytes: number; seq: number }>;
            if (candidates.length === 0) break;
            const remove = database.prepare("DELETE FROM conversation_entries WHERE seq = ?");
            let payloadBytes = this.#trackedPayloadBytes();
            database.exec("BEGIN IMMEDIATE");
            try {
                for (const candidate of candidates) {
                    if (payloadBytes <= this.#maxBytes) break;
                    remove.run(candidate.seq);
                    payloadBytes -= candidate.payloadBytes;
                    removed = true;
                }
                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
            this.#payloadBytes = Math.max(0, payloadBytes);
        }

        if (removed && this.#trackedPayloadBytes() <= this.#maxBytes) {
            const fileBytes = fileSize(this.#filePath) + fileSize(`${this.#filePath}-wal`);
            if (fileBytes > this.#maxBytes) {
                database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
                if (fileSize(this.#filePath) > this.#maxBytes) database.exec("VACUUM");
            }
        }
    }

    #readPayloadBytes(database: DatabaseSync): number {
        const row = database.prepare(`
            SELECT COALESCE(SUM(${conversationPayloadBytesSql()}), 0) AS payloadBytes
            FROM conversation_entries
        `).get() as { payloadBytes: number };
        return row.payloadBytes;
    }

    #readEntryPayloadBytes(database: DatabaseSync, kind: ConversationEntryKind, id: string): number {
        const row = database.prepare(`
            SELECT ${conversationPayloadBytesSql()} AS payloadBytes
            FROM conversation_entries
            WHERE kind = ? AND id = ?
        `).get(kind, id) as { payloadBytes: number } | undefined;
        return row?.payloadBytes ?? 0;
    }

    #trackedPayloadBytes(): number {
        if (this.#payloadBytes === undefined) {
            throw new Error("Conversation payload accounting is not initialized.");
        }
        return this.#payloadBytes;
    }

    #migrateLegacyComments(): void {
        if (this.#readMetadata(LEGACY_COMMENT_MIGRATION_KEY) === "complete") return;
        const database = this.#database!;
        const messages = this.#readLegacyComments();
        database.exec("BEGIN IMMEDIATE");
        try {
            const insert = database.prepare(`
                INSERT INTO conversation_entries(
                    kind, id, ctx_id, created_at, text, status, call_id, delivered_at, failed_at, error
                ) VALUES ('comment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind, id) DO NOTHING
            `);
            for (const record of messages) {
                insert.run(
                    record.id,
                    record.ctxId,
                    record.createdAt,
                    record.text,
                    record.status,
                    record.callId ?? null,
                    record.deliveredAt ?? null,
                    record.failedAt ?? null,
                    record.error ?? null,
                );
            }
            this.#writeMetadataInDatabase(database, LEGACY_COMMENT_MIGRATION_KEY, "complete");
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        if (this.#legacyContextMessagesFile !== undefined && existsSync(this.#legacyContextMessagesFile)) {
            const backup = migrationBackupPath(this.#legacyContextMessagesFile);
            renameSync(this.#legacyContextMessagesFile, backup);
        }
    }

    #readLegacyComments(): ContextMessageRecord[] {
        const filePath = this.#legacyContextMessagesFile;
        if (filePath === undefined || !existsSync(filePath)) return [];
        const document = new ContextMessageState().normalizeDocument(
            JSON.parse(readFileSync(filePath, "utf8")) as unknown,
        );
        return document.messages;
    }

    #readMetadata(key: string): string | undefined {
        const row = this.#open().prepare(
            "SELECT value FROM conversation_metadata WHERE key = ?"
        ).get(key) as { value: string } | undefined;
        return row?.value;
    }

    #writeMetadata(key: string, value: string): void {
        this.#writeMetadataInDatabase(this.#open(), key, value);
    }

    #writeMetadataInDatabase(database: DatabaseSync, key: string, value: string): void {
        database.prepare(`
            INSERT INTO conversation_metadata(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value);
    }

}

function toConversationEntry(row: ConversationRow): ConversationEntry {
    return {
        ...(row.callId === null ? {} : { callId: row.callId }),
        createdAt: row.createdAt,
        ctxId: row.ctxId,
        ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
        ...(row.error === null ? {} : { error: row.error }),
        ...(row.failedAt === null ? {} : { failedAt: row.failedAt }),
        id: row.id,
        kind: row.kind,
        ...(row.status === null ? {} : { status: row.status }),
        text: row.text,
    };
}

function toContextMessageRecord(row: ConversationRow, instance: string): ContextMessageRecord {
    if (row.kind !== "comment" || row.status === null) {
        throw new Error("Conversation row is not a Context Comment.");
    }
    return {
        ...(row.callId === null ? {} : { callId: row.callId }),
        createdAt: row.createdAt,
        ctxId: row.ctxId,
        ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
        ...(row.error === null ? {} : { error: row.error }),
        ...(row.failedAt === null ? {} : { failedAt: row.failedAt }),
        id: row.id,
        instance,
        status: row.status,
        text: row.text,
    };
}

function applyByteBudget<T>(records: T[], maxBytes: number | undefined): T[] {
    if (maxBytes === undefined) return records;
    const accepted: T[] = [];
    let bytes = 2;
    for (const record of [...records].reverse()) {
        const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8") + (accepted.length === 0 ? 0 : 1);
        if (bytes + recordBytes > maxBytes) break;
        accepted.unshift(record);
        bytes += recordBytes;
    }
    return accepted;
}

function conversationPayloadBytesSql(): string {
    return [
        "64",
        "length(CAST(kind AS BLOB))",
        "length(CAST(id AS BLOB))",
        "length(CAST(ctx_id AS BLOB))",
        "length(CAST(created_at AS BLOB))",
        "length(CAST(text AS BLOB))",
        "COALESCE(length(CAST(status AS BLOB)), 0)",
        "COALESCE(length(CAST(call_id AS BLOB)), 0)",
        "COALESCE(length(CAST(delivered_at AS BLOB)), 0)",
        "COALESCE(length(CAST(failed_at AS BLOB)), 0)",
        "COALESCE(length(CAST(error AS BLOB)), 0)",
    ].join(" + ");
}

function fileSize(path: string): number {
    try {
        return statSync(path).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
    }
}

function migrationBackupPath(source: string): string {
    const base = `${source}.migrated-v1.bak`;
    if (!existsSync(base)) return base;
    for (let index = 1; index < 10_000; index += 1) {
        const candidate = `${base}.${index}`;
        if (!existsSync(candidate)) return candidate;
    }
    throw new Error(`Unable to allocate a migration backup path for ${source}.`);
}
