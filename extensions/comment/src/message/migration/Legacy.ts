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
const LEGACY_MAILING_IMPORT_MARKER = "migration.legacy-mailing-notifications-imported";
const NOTIFICATION_IDENTITY_COLUMNS = [
    "instance", "workspace", "ctx_id", "mail_id", "notification_kind",
] as const;
const NOTIFICATION_COLUMNS = [
    ...NOTIFICATION_IDENTITY_COLUMNS, "comment_id", "created_at", "text", "queued_event_recorded",
] as const;
type NotificationRow = Record<(typeof NOTIFICATION_COLUMNS)[number], SQLInputValue>;

function reconcileLegacyMessageDatabase(sourceFile: string, targetFile: string): void {
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    let target: DatabaseSync | undefined;
    try {
        // Read entries, receipts and metadata from one source snapshot.
        source.exec("BEGIN");
        target = new DatabaseSync(targetFile, { timeout: 5_000 });
        const sourceTables = messageTables(source, sourceFile);
        target.exec("BEGIN IMMEDIATE");
        try {
            const targetTables = messageTables(target, targetFile);
            const metadata = targetTables.metadata ?? "conversation_metadata";
            if (targetTables.metadata === undefined) {
                target.exec(`CREATE TABLE ${metadata} (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
            }
            const imported = target.prepare(`SELECT value FROM ${metadata} WHERE key = ?`);
            const insertMetadata = target.prepare(
                `INSERT OR IGNORE INTO ${metadata} (key, value) VALUES (?, ?)`,
            );
            // Keep the historical marker's retention guarantee. Older builds
            // set it without copying receipts, so repair those independently.
            if (imported.get(LEGACY_IMPORT_MARKER) === undefined) {
                const insert = target.prepare(
                    `INSERT INTO ${targetTables.entries} (${ENTRY_COLUMNS.join(", ")}) VALUES (${ENTRY_COLUMNS.map(() => "?").join(", ")}) ON CONFLICT(kind, id) DO NOTHING`,
                );
                const compactedReceipt = targetTables.notifications ? target.prepare(`
                    SELECT ${NOTIFICATION_COLUMNS.join(", ")} FROM mailing_notifications
                    WHERE comment_id = ? AND NOT EXISTS (
                        SELECT 1 FROM ${targetTables.entries} WHERE kind = 'comment' AND id = comment_id
                    )
                `) : undefined;
                for (const row of source.prepare(
                    `SELECT ${ENTRY_COLUMNS.join(", ")} FROM ${sourceTables.entries} ORDER BY seq`,
                ).iterate() as Iterable<Record<string, SQLInputValue>>) {
                    const receipt = row.kind === "comment" ? compactedReceipt?.get(row.id ?? null) as NotificationRow | undefined : undefined;
                    if (receipt !== undefined) {
                        if (receipt.ctx_id !== row.ctx_id || receipt.created_at !== row.created_at || receipt.text !== row.text)
                            throw notificationConflict(receipt, "compacted Comment ID refers to a different admission");
                        // A target receipt without history is an intentional
                        // retention tombstone, including on the first merge.
                        continue;
                    }
                    insert.run(...ENTRY_COLUMNS.map((column) => row[column] ?? null));
                }
                if (sourceTables.metadata !== undefined) {
                    for (const row of source.prepare(
                        `SELECT key, value FROM ${sourceTables.metadata}`,
                    ).iterate() as Iterable<{ key: string; value: string }>) {
                        if (row.key !== LEGACY_IMPORT_MARKER && row.key !== LEGACY_MAILING_IMPORT_MARKER)
                            insertMetadata.run(row.key, row.value);
                    }
                }
            }
            if (sourceTables.notifications && imported.get(LEGACY_MAILING_IMPORT_MARKER) === undefined) {
                for (const receipt of source.prepare(
                    `SELECT ${NOTIFICATION_COLUMNS.join(", ")} FROM mailing_notifications`,
                ).iterate() as Iterable<NotificationRow>) {
                    if (!targetTables.notifications) {
                        throw new Error("Legacy Mailing receipts require an upgraded target message database; refusing to discard receipts.");
                    }
                    mergeNotification(source, sourceTables.entries, target, targetTables.entries, receipt);
                }
                insertMetadata.run(LEGACY_MAILING_IMPORT_MARKER, basename(sourceFile));
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

function mergeNotification(
    source: DatabaseSync,
    sourceEntries: string,
    target: DatabaseSync,
    targetEntries: string,
    receipt: NotificationRow,
): void {
    const identity = NOTIFICATION_IDENTITY_COLUMNS.map((column) => receipt[column]);
    // Receipts outlive retained history, but any surviving Comment must still
    // describe this admission. Never bind a receipt to an unrelated ID collision.
    for (const [database, entries] of [[source, sourceEntries], [target, targetEntries]] as const) {
        const entry = database.prepare(
            `SELECT ctx_id, created_at, text FROM ${entries} WHERE kind = 'comment' AND id = ?`,
        ).get(receipt.comment_id);
        if (entry !== undefined && (entry.ctx_id !== receipt.ctx_id ||
            entry.created_at !== receipt.created_at || entry.text !== receipt.text)) {
            throw notificationConflict(receipt, "Comment ID refers to a different admission");
        }
    }
    const where = NOTIFICATION_IDENTITY_COLUMNS.map((column) => `${column} = ?`).join(" AND ");
    const existing = target.prepare(`SELECT comment_id, created_at, text FROM mailing_notifications WHERE ${where}`).get(...identity);
    if (existing !== undefined) {
        if (existing.comment_id !== receipt.comment_id || existing.created_at !== receipt.created_at || existing.text !== receipt.text)
            throw notificationConflict(receipt, "identity already refers to a different admission");
        // Either durable acknowledgement is sufficient; do not replay an event
        // already recorded in the target when the source is an older snapshot.
        target.prepare(`UPDATE mailing_notifications SET queued_event_recorded = MAX(queued_event_recorded, ?) WHERE ${where}`)
            .run(receipt.queued_event_recorded, ...identity);
    } else {
        if (target.prepare("SELECT 1 FROM mailing_notifications WHERE comment_id = ?").get(receipt.comment_id) !== undefined)
            throw notificationConflict(receipt, "Comment ID already belongs to another identity");
        target.prepare(`INSERT INTO mailing_notifications (${NOTIFICATION_COLUMNS.join(", ")}) VALUES (${NOTIFICATION_COLUMNS.map(() => "?").join(", ")})`)
            .run(...NOTIFICATION_COLUMNS.map((column) => receipt[column]));
    }
}

function notificationConflict(receipt: NotificationRow, reason: string): Error {
    const identity = NOTIFICATION_IDENTITY_COLUMNS.map((column) => receipt[column]);
    return new Error(
        `Legacy Mailing migration conflict for ${JSON.stringify(identity)}: ${reason}. The merge was rolled back.`,
    );
}

function messageTables(database: DatabaseSync, filePath: string): {
    entries: "conversation_entries" | "message_entries";
    metadata: "conversation_metadata" | "message_metadata" | undefined;
    notifications: boolean;
} {
    if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
        throw new Error(`Legacy message migration found invalid SQLite data: ${filePath}`);
    }
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 1 && version !== 2 && version !== 3) {
        throw new Error(`Unsupported legacy message database schema ${String(version)}: ${filePath}`);
    }
    const entries = version === 1 ? "conversation_entries" : "message_entries";
    const metadata = version === 1 ? "conversation_metadata" : "message_metadata";
    const tableExists = (table: string) => database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) !== undefined;
    for (const table of [entries, ...(version === 1 ? [] : [metadata]), ...(version === 3 ? ["mailing_notifications"] : [])]) {
        if (!tableExists(table)) {
            throw new Error(`Legacy message database is missing ${table}: ${filePath}`);
        }
    }
    return { entries, metadata: tableExists(metadata) ? metadata : undefined, notifications: version === 3 };
}
