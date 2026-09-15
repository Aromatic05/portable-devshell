import type { DatabaseSync } from "node:sqlite";

export interface SqliteSchemaCompatibility {
    databaseLabel: string;
    filePath: string;
    supportedVersion: number;
}

export class SqliteSchemaVersionTooNewError extends Error {
    readonly actualVersion: number;
    readonly databaseLabel: string;
    readonly filePath: string;
    readonly supportedVersion: number;

    constructor(options: SqliteSchemaCompatibility & { actualVersion: number }) {
        super(
            `${options.databaseLabel} schema version ${options.actualVersion} is newer than the supported version ${options.supportedVersion}. ` +
            `Upgrade portable-devshell before opening ${options.filePath}. The database was not modified.`
        );
        this.name = "SqliteSchemaVersionTooNewError";
        this.actualVersion = options.actualVersion;
        this.databaseLabel = options.databaseLabel;
        this.filePath = options.filePath;
        this.supportedVersion = options.supportedVersion;
    }
}

export function assertSqliteSchemaVersionSupported(
    database: DatabaseSync,
    options: SqliteSchemaCompatibility
): number {
    const actualVersion = readSqlitePragmaNumber(database, "user_version");
    if (actualVersion > options.supportedVersion) {
        throw new SqliteSchemaVersionTooNewError({ ...options, actualVersion });
    }
    return actualVersion;
}

export function readSqlitePragmaNumber(
    database: DatabaseSync,
    name: "freelist_count" | "page_count" | "page_size" | "user_version"
): number {
    const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
    return Number(Object.values(row)[0] ?? 0);
}
