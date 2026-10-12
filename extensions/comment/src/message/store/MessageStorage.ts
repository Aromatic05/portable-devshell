import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Import legacy message records into extension-owned storage. Always retain
 * the original as a recovery copy. A previously created target may already
 * contain newer records: merge missing legacy entries, never replace them.
 */
export async function migrateMessageDatabase(options: {
    instance: string;
    targetFile: string;
    sourceFile?: string;
}): Promise<void> {
    const { instance, targetFile } = options;
    // Historical filenames used the raw instance name as a directory member.
    // Never interpret path separators or parent directories from a name.
    if (basename(instance) !== instance || instance === "." || instance === "..") {
        return;
    }
    const devshellHome = process.env.PORTABLE_DEVSHELL_HOME ??
        join(homedir(), ".devshell");
    const legacyDirectory = join(devshellHome, instance, "control-worker");
    const candidates = options.sourceFile === undefined
        ? [
            join(legacyDirectory, "conversation.sqlite3"),
            join(legacyDirectory, "message.sqlite3"),
        ]
        : [options.sourceFile];
    const present = candidates.filter((candidate) =>
        candidate !== targetFile && existsSync(candidate)
    );
    if (present.length > 1) {
        throw new Error(
            `Multiple legacy message databases exist for ${instance}; refusing to choose one and discard data.`,
        );
    }
    const sourceFile = present[0];
    if (sourceFile === undefined) return;
    if (existsSync(targetFile)) {
        reconcileLegacyMessageDatabase(sourceFile, targetFile);
        return;
    }
    await mkdir(dirname(targetFile), { recursive: true });
    const temporaryFile = `${targetFile}.${randomUUID()}.migrating`;
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    try {
        await backup(source, temporaryFile);
        try {
            await link(temporaryFile, targetFile);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            reconcileLegacyMessageDatabase(sourceFile, targetFile);
        }
    } finally {
        source.close();
        await unlink(temporaryFile).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
    }
}

const ENTRY_COLUMNS = [
    "kind", "id", "ctx_id", "created_at", "text", "status",
    "call_id", "delivered_at", "failed_at", "error",
] as const;
const LEGACY_IMPORT_MARKER = "migration.legacy-conversation-imported";

function reconcileLegacyMessageDatabase(sourceFile: string, targetFile: string): void {
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    let target: DatabaseSync | undefined;
    try {
        target = new DatabaseSync(targetFile, { timeout: 5_000 });
        const sourceTables = messageTables(source, sourceFile);
        const targetTables = messageTables(target, targetFile);
        // The marker prevents intentionally expired/compacted legacy records
        // from being reimported every time the extension is activated.
        if (target.prepare(
            `SELECT value FROM ${targetTables.metadata} WHERE key = ?`,
        ).get(LEGACY_IMPORT_MARKER) !== undefined) return;

        const insert = target.prepare(
            `INSERT OR IGNORE INTO ${targetTables.entries} (${ENTRY_COLUMNS.join(", ")}) VALUES (${ENTRY_COLUMNS.map(() => "?").join(", ")})`,
        );
        const insertMetadata = target.prepare(
            `INSERT OR IGNORE INTO ${targetTables.metadata} (key, value) VALUES (?, ?)`,
        );
        target.exec("BEGIN IMMEDIATE");
        try {
            for (const row of source.prepare(
                `SELECT ${ENTRY_COLUMNS.join(", ")} FROM ${sourceTables.entries} ORDER BY seq`,
            ).iterate() as Iterable<Record<string, SQLInputValue>>) {
                insert.run(...ENTRY_COLUMNS.map((column) => row[column] ?? null));
            }
            for (const row of source.prepare(
                `SELECT key, value FROM ${sourceTables.metadata}`,
            ).iterate() as Iterable<{ key: string; value: string }>) {
                insertMetadata.run(row.key, row.value);
            }
            insertMetadata.run(LEGACY_IMPORT_MARKER, basename(sourceFile));
            target.exec("COMMIT");
        } catch (error) {
            target.exec("ROLLBACK");
            throw error;
        }
    } finally {
        target?.close();
        source.close();
    }
}

function messageTables(database: DatabaseSync, filePath: string): {
    entries: "conversation_entries" | "message_entries";
    metadata: "conversation_metadata" | "message_metadata";
} {
    if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
        throw new Error(`Legacy message migration found invalid SQLite data: ${filePath}`);
    }
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 1 && version !== 2) {
        throw new Error(`Unsupported legacy message database schema ${String(version)}: ${filePath}`);
    }
    const entries = version === 1 ? "conversation_entries" : "message_entries";
    const metadata = version === 1 ? "conversation_metadata" : "message_metadata";
    for (const table of [entries, metadata]) {
        if (database.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table) === undefined) {
            throw new Error(`Legacy message database is missing ${table}: ${filePath}`);
        }
    }
    return { entries, metadata };
}
