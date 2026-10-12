import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
    ExtensionDatabaseCapability,
    ExtensionDatabaseConnection,
    ExtensionSqlRow,
    ExtensionSqlValue,
} from "@portable-devshell/extension/database";

/** Real SQLite using the same async capability contract, without Control imports. */
export function databaseConnection(
    filePath: string,
): Promise<ExtensionDatabaseConnection> {
    mkdirSync(dirname(filePath), { recursive: true });
    const database = new DatabaseSync(filePath, { timeout: 5_000 });
    let closed = false;
    const connection: ExtensionDatabaseConnection = {
        async all<T extends ExtensionSqlRow>(
            sql: string,
            values: readonly ExtensionSqlValue[] = [],
        ) {
            return database.prepare(sql).all(...values) as T[];
        },
        async close() {
            if (closed) return;
            closed = true;
            database.close();
        },
        async exec(sql: string) {
            database.exec(sql);
        },
        async get<T extends ExtensionSqlRow>(
            sql: string,
            values: readonly ExtensionSqlValue[] = [],
        ) {
            return database.prepare(sql).get(...values) as T | undefined;
        },
        async run(sql: string, values: readonly ExtensionSqlValue[] = []) {
            return Number(database.prepare(sql).run(...values).changes);
        },
        async transaction<T>(
            work: (db: ExtensionDatabaseConnection) => Promise<T>,
        ) {
            database.exec("BEGIN IMMEDIATE");
            try {
                const result = await work(connection);
                database.exec("COMMIT");
                return result;
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
        },
    };
    return Promise.resolve(connection);
}

export function databaseCapability(
    resolve: (name: string) => string,
): ExtensionDatabaseCapability {
    return {
        open: async (name: string) => await databaseConnection(resolve(name)),
    };
}
