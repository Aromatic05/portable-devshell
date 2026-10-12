import { DatabaseSync } from "node:sqlite";

import { AUDIT_DATABASE_SCHEMA_VERSION } from "./index.js";
import {
    readSqlitePragmaNumber,
    SqliteSchemaVersionTooNewError,
} from "./Schema.js";

const OLDEST_MIGRATABLE_SCHEMA = 2;

/**
 * Offline database migration. The caller must stop the owning Instance before
 * invoking migrateAuditDatabase; the normal Audit runtime never reads v2.
 */
export function inspectAuditDatabase(filePath: string): {
    changed: boolean;
    version: number;
} {
    const database = new DatabaseSync(filePath, { readOnly: true });
    try {
        const version = readSqlitePragmaNumber(database, "user_version");
        assertAuditSchema(database, filePath, version);
        return { changed: version !== AUDIT_DATABASE_SCHEMA_VERSION, version };
    } finally {
        database.close();
    }
}

export function migrateAuditDatabase(filePath: string): boolean {
    const database = new DatabaseSync(filePath, { timeout: 5_000 });
    try {
        const version = readSqlitePragmaNumber(database, "user_version");
        assertAuditSchema(database, filePath, version);
        if (version === AUDIT_DATABASE_SCHEMA_VERSION) return false;

        database.exec("BEGIN IMMEDIATE");
        try {
            database.exec(`
                CREATE TABLE state_records (
                    namespace TEXT NOT NULL,
                    key TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
                    PRIMARY KEY(namespace, key)
                ) STRICT;
            `);
            database.exec(`PRAGMA user_version = ${AUDIT_DATABASE_SCHEMA_VERSION}`);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        assertAuditSchema(database, filePath, AUDIT_DATABASE_SCHEMA_VERSION);
        return true;
    } finally {
        database.close();
    }
}

function assertAuditSchema(
    database: DatabaseSync,
    filePath: string,
    version: number,
): void {
    if (version > AUDIT_DATABASE_SCHEMA_VERSION) {
        throw new SqliteSchemaVersionTooNewError({
            actualVersion: version,
            databaseLabel: "Audit database",
            filePath,
            supportedVersion: AUDIT_DATABASE_SCHEMA_VERSION,
        });
    }
    if (version < OLDEST_MIGRATABLE_SCHEMA) {
        throw new Error(
            `Audit database schema version ${version} is unsupported in ${filePath}; the database was not modified.`,
        );
    }
    const integrity = database.prepare("PRAGMA quick_check").get() as {
        quick_check: string;
    };
    if (integrity.quick_check !== "ok") {
        throw new Error(`Audit database integrity check failed: ${filePath}.`);
    }
    const columns = new Set(
        (database.prepare("PRAGMA table_info(audit_records)").all() as Array<{
            name: string;
        }>).map(({ name }) => name),
    );
    if (
        !["id", "collection", "occurred_at_ms", "payload_bytes", "payload", "body", "body_codec"]
            .every((name) => columns.has(name))
    ) {
        throw new Error(`Audit database has an invalid audit_records table: ${filePath}.`);
    }
    for (const table of version === AUDIT_DATABASE_SCHEMA_VERSION
        ? ["audit_metadata", "state_records"]
        : ["audit_metadata"]) {
        if (
            database.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            ).get(table) === undefined
        ) {
            throw new Error(`Audit database is missing ${table}: ${filePath}.`);
        }
    }
}
