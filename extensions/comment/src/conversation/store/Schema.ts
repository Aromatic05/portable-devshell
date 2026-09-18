import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const CONVERSATION_DATABASE_SCHEMA_VERSION = 1;
export const defaultConversationStorageLimits = {
    maxBytes: 512 * 1024 * 1024,
    retentionDays: 90,
} as const;

export function openConversationDatabase(filePath: string): DatabaseSync {
    mkdirSync(dirname(filePath), { recursive: true });
    const require = createRequire(import.meta.url);
    const { DatabaseSync } =
        require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(filePath, { timeout: 5_000 });
    try {
        initializeConversationSchema(database, filePath);
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = NORMAL");
        return database;
    } catch (error) {
        database.close();
        throw error;
    }
}

function initializeConversationSchema(
    database: DatabaseSync,
    filePath: string,
): void {
    const userVersion = readConversationSchemaVersion(database, filePath);
    if (userVersion === CONVERSATION_DATABASE_SCHEMA_VERSION) {
        const present =
            database
                .prepare(
                    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_entries'",
                )
                .get() !== undefined;
        if (!present) {
            throw new Error(
                `Conversation database schema version ${CONVERSATION_DATABASE_SCHEMA_VERSION} is inconsistent: ` +
                    "conversation_entries is missing. Refusing to modify the database.",
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

function readConversationSchemaVersion(
    database: DatabaseSync,
    filePath: string,
): number {
    const row = database.prepare("PRAGMA user_version").get() as Record<
        string,
        number
    >;
    const version = Number(Object.values(row)[0] ?? 0);
    if (version > CONVERSATION_DATABASE_SCHEMA_VERSION) {
        throw new Error(
            `Conversation database schema version ${version} is newer than the supported version ${CONVERSATION_DATABASE_SCHEMA_VERSION}. ` +
                `Upgrade portable-devshell before opening ${filePath}. The database was not modified.`,
        );
    }
    return version;
}
