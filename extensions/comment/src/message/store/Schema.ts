import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const MESSAGE_DATABASE_SCHEMA_VERSION = 2;
export const defaultMessageStorageLimits = {
    maxBytes: 512 * 1024 * 1024,
    retentionDays: 90,
} as const;

export function openMessageDatabase(filePath: string): DatabaseSync {
    mkdirSync(dirname(filePath), { recursive: true });
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath, { timeout: 5_000 });
    try {
        initializeMessageSchema(database, filePath);
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = NORMAL");
        return database;
    } catch (error) {
        database.close();
        throw error;
    }
}

function initializeMessageSchema(
    database: DatabaseSync,
    filePath: string,
): void {
    const userVersion = readMessageSchemaVersion(database, filePath);
    if (userVersion === MESSAGE_DATABASE_SCHEMA_VERSION) {
        if (!tableExists(database, "message_entries")) {
            throw new Error(
                `Message database schema version ${MESSAGE_DATABASE_SCHEMA_VERSION} is inconsistent: ` +
                    "message_entries is missing. Refusing to modify the database.",
            );
        }
        return;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
        if (userVersion === 1) migrateVersionOne(database);
        else createCurrentSchema(database);
        database.exec(`PRAGMA user_version = ${MESSAGE_DATABASE_SCHEMA_VERSION}`);
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

function createCurrentSchema(database: DatabaseSync): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS message_entries (
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
        CREATE INDEX IF NOT EXISTS message_entries_context_time
            ON message_entries(ctx_id, created_at, seq);
        CREATE INDEX IF NOT EXISTS message_entries_call
            ON message_entries(call_id)
            WHERE call_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS message_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) STRICT;
    `);
}

function migrateVersionOne(database: DatabaseSync): void {
    // @compat comment-message-storage-v1
    // v1 used the old domain noun in table names. Rename in place once.
    if (!tableExists(database, "conversation_entries")) {
        throw new Error(
            "Message database schema version 1 is inconsistent: the legacy entries table is missing.",
        );
    }
    database.exec("ALTER TABLE conversation_entries RENAME TO message_entries");
    if (tableExists(database, "conversation_metadata")) {
        database.exec("ALTER TABLE conversation_metadata RENAME TO message_metadata");
    } else {
        database.exec(`
            CREATE TABLE message_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
        `);
    }
    database.exec(`
        DROP INDEX IF EXISTS conversation_entries_context_time;
        DROP INDEX IF EXISTS conversation_entries_call;
        CREATE INDEX IF NOT EXISTS message_entries_context_time
            ON message_entries(ctx_id, created_at, seq);
        CREATE INDEX IF NOT EXISTS message_entries_call
            ON message_entries(call_id)
            WHERE call_id IS NOT NULL;
    `);
}

function readMessageSchemaVersion(
    database: DatabaseSync,
    filePath: string,
): number {
    const row = database.prepare("PRAGMA user_version").get() as Record<
        string,
        number
    >;
    const version = Number(Object.values(row)[0] ?? 0);
    if (version > MESSAGE_DATABASE_SCHEMA_VERSION) {
        throw new Error(
            `Message database schema version ${version} is newer than the supported version ${MESSAGE_DATABASE_SCHEMA_VERSION}. ` +
                `Upgrade portable-devshell before opening ${filePath}. The database was not modified.`,
        );
    }
    return version;
}

function tableExists(database: DatabaseSync, name: string): boolean {
    return (
        database
            .prepare(
                "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(name) !== undefined
    );
}
