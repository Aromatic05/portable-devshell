import {
    existsSync,
    readFileSync,
    renameSync,
} from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { ContextMessageRecord } from "@portable-devshell/shared";

import { CommentState } from "../../comment/CommentState.js";

const LEGACY_COMMENT_MIGRATION_KEY = "migration:context-messages-json-v1";

/**
 * @compat comment-json-v1
 * @removeAt 0.7.10
 */
export function migrateLegacyComments(
    database: DatabaseSync,
    legacyFilePath: string | undefined,
): void {
    if (readMetadata(database, LEGACY_COMMENT_MIGRATION_KEY) === "complete")
        return;
    const comments = readLegacyComments(legacyFilePath);
    database.exec("BEGIN IMMEDIATE");
    try {
        const insert = database.prepare(`
            INSERT INTO conversation_entries(
                kind, id, ctx_id, created_at, text, status, call_id, delivered_at, failed_at, error
            ) VALUES ('comment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(kind, id) DO NOTHING
        `);
        for (const record of comments) {
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
        writeMetadata(database, LEGACY_COMMENT_MIGRATION_KEY, "complete");
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
    if (legacyFilePath !== undefined && existsSync(legacyFilePath))
        renameSync(legacyFilePath, migrationBackupPath(legacyFilePath));
}

function readLegacyComments(filePath: string | undefined): ContextMessageRecord[] {
    if (filePath === undefined || !existsSync(filePath)) return [];
    return new CommentState().normalizeDocument(
        JSON.parse(readFileSync(filePath, "utf8")) as unknown,
    ).messages;
}

function readMetadata(database: DatabaseSync, key: string): string | undefined {
    const row = database
        .prepare("SELECT value FROM conversation_metadata WHERE key = ?")
        .get(key) as { value: string } | undefined;
    return row?.value;
}

function writeMetadata(database: DatabaseSync, key: string, value: string): void {
    database
        .prepare(
            `
            INSERT INTO conversation_metadata(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        )
        .run(key, value);
}

function migrationBackupPath(source: string): string {
    const base = `${source}.migrated-v1.bak`;
    if (!existsSync(base)) return base;
    for (let index = 1; index < 10_000; index += 1) {
        const candidate = `${base}.${index}`;
        if (!existsSync(candidate)) return candidate;
    }
    throw new Error(
        `Unable to allocate a migration backup path for ${source}.`,
    );
}
