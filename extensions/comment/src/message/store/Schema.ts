import type { ExtensionDatabaseConnection } from "@portable-devshell/extension/database";

export const MESSAGE_DATABASE_SCHEMA_VERSION = 2;
export const defaultMessageStorageLimits = {
    maxBytes: 512 * 1024 * 1024,
    retentionDays: 90,
} as const;

export async function openMessageDatabase(
    open: () => Promise<ExtensionDatabaseConnection>,
    filePath: string,
): Promise<ExtensionDatabaseConnection> {
    const database = await open();
    try {
        await initializeMessageSchema(database, filePath);
        await database.exec("PRAGMA journal_mode = WAL");
        await database.exec("PRAGMA synchronous = NORMAL");
        return database;
    } catch (error) {
        await database.close();
        throw error;
    }
}

async function initializeMessageSchema(
    database: ExtensionDatabaseConnection,
    filePath: string,
): Promise<void> {
    const userVersion = await readMessageSchemaVersion(database, filePath);
    if (userVersion === MESSAGE_DATABASE_SCHEMA_VERSION) {
        if (!(await tableExists(database, "message_entries"))) {
            throw new Error(
                `Message database schema version ${MESSAGE_DATABASE_SCHEMA_VERSION} is inconsistent: ` +
                    "message_entries is missing. Refusing to modify the database.",
            );
        }
        return;
    }

    await database.transaction(async (database) => {
        if (userVersion === 1) await migrateVersionOne(database);
        else await createCurrentSchema(database);
        await database.exec(
            `PRAGMA user_version = ${MESSAGE_DATABASE_SCHEMA_VERSION}`,
        );
    });
}

async function createCurrentSchema(
    database: ExtensionDatabaseConnection,
): Promise<void> {
    await database.exec(`
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

async function migrateVersionOne(
    database: ExtensionDatabaseConnection,
): Promise<void> {
    // @compat comment-message-storage-v1
    // v1 used the old domain noun in table names. Rename in place once.
    if (!(await tableExists(database, "conversation_entries"))) {
        throw new Error(
            "Message database schema version 1 is inconsistent: the legacy entries table is missing.",
        );
    }
    await database.exec(
        "ALTER TABLE conversation_entries RENAME TO message_entries",
    );
    if (await tableExists(database, "conversation_metadata")) {
        await database.exec(
            "ALTER TABLE conversation_metadata RENAME TO message_metadata",
        );
    } else {
        await database.exec(`
            CREATE TABLE message_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;
        `);
    }
    await database.exec(`
        DROP INDEX IF EXISTS conversation_entries_context_time;
        DROP INDEX IF EXISTS conversation_entries_call;
        CREATE INDEX IF NOT EXISTS message_entries_context_time
            ON message_entries(ctx_id, created_at, seq);
        CREATE INDEX IF NOT EXISTS message_entries_call
            ON message_entries(call_id)
            WHERE call_id IS NOT NULL;
    `);
}

async function readMessageSchemaVersion(
    database: ExtensionDatabaseConnection,
    filePath: string,
): Promise<number> {
    const row = (await database.get("PRAGMA user_version", [])) as Record<
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

async function tableExists(
    database: ExtensionDatabaseConnection,
    name: string,
): Promise<boolean> {
    return (
        (await database.get(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
            [name],
        )) !== undefined
    );
}
