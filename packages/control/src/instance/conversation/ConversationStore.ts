import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
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
const LEGACY_COMMENT_MIGRATION_KEY = "migration:context-messages-json-v1";
const LEGACY_REPORT_MIGRATION_KEY = "migration:todo-report-audit-v1";

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
    #database?: DatabaseSync;

    constructor(options: {
        filePath: string;
        instanceName: string;
        legacyContextMessagesFile?: string;
    }) {
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#legacyContextMessagesFile = options.legacyContextMessagesFile;
    }

    close(): void {
        this.#database?.close();
        this.#database = undefined;
    }

    list(input: ConversationListInput = {}): ConversationEntry[] {
        return applyByteBudget(
            this.#listRows(input, undefined).map(toConversationEntry),
            input.maxBytes,
        );
    }

    listComments(input: ContextMessageListInput = {}): ContextMessageRecord[] {
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
        this.#open().prepare(`
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
    }

    deliverComments(ctxId: string, callId: string, deliveredAt: string): ContextMessageRecord[] {
        const database = this.#open();
        database.exec("BEGIN IMMEDIATE");
        try {
            const pending = this.pendingComments(ctxId);
            if (pending.length === 0) {
                database.exec("COMMIT");
                return [];
            }
            const update = database.prepare(`
                UPDATE conversation_entries
                SET status = 'delivered', call_id = ?, delivered_at = ?, failed_at = NULL, error = NULL
                WHERE kind = 'comment' AND id = ?
            `);
            for (const record of pending) update.run(callId, deliveredAt, record.id);
            database.exec("COMMIT");
            return pending.map((record) => ({
                ...record,
                callId,
                deliveredAt,
                error: undefined,
                failedAt: undefined,
                status: "delivered" as const,
            }));
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
    }

    failComments(ids: ReadonlySet<string>, error: string, failedAt: string): void {
        if (ids.size === 0) return;
        const database = this.#open();
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
    }

    appendReport(input: { callId: string; createdAt: string; ctxId: string; text: string }): void {
        this.#open().prepare(`
            INSERT INTO conversation_entries(kind, id, ctx_id, created_at, text, call_id)
            VALUES ('report', ?, ?, ?, ?, ?)
            ON CONFLICT(kind, id) DO NOTHING
        `).run(input.callId, input.ctxId, input.createdAt, input.text, input.callId);
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

function migrationBackupPath(source: string): string {
    const base = `${source}.migrated-v1.bak`;
    if (!existsSync(base)) return base;
    for (let index = 1; index < 10_000; index += 1) {
        const candidate = `${base}.${index}`;
        if (!existsSync(candidate)) return candidate;
    }
    throw new Error(`Unable to allocate a migration backup path for ${source}.`);
}
