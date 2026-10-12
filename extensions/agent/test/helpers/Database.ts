import { DatabaseSync } from "node:sqlite";

import type { ExtensionContext } from "@portable-devshell/extension";

type DatabaseCapability = NonNullable<
    ExtensionContext["capabilities"]["database"]
>;
type Connection = Awaited<ReturnType<DatabaseCapability["open"]>>;

/** Exercise the capability contract against real SQLite without importing Control. */
export function databaseFixture(path = ":memory:") {
    let failCommit = false;
    let opens = 0;
    let closes = 0;
    const capability: DatabaseCapability = {
        async open(name) {
            if (name !== "providers")
                throw new Error("Unexpected database name: " + name);
            const database = new DatabaseSync(path);
            opens += 1;
            const connection: Connection = {
                async all<T>(sql: string, parameters = []) {
                    return database.prepare(sql).all(...parameters) as T[];
                },
                async close() {
                    database.close();
                    closes += 1;
                },
                async exec(sql) {
                    database.exec(sql);
                },
                async get<T>(sql: string, parameters = []) {
                    return database.prepare(sql).get(...parameters) as
                        T | undefined;
                },
                async run(sql, parameters = []) {
                    return Number(
                        database.prepare(sql).run(...parameters).changes,
                    );
                },
                async transaction(operation) {
                    database.exec("BEGIN IMMEDIATE");
                    try {
                        const result = await operation(connection);
                        if (failCommit) {
                            failCommit = false;
                            throw new Error("injected commit failure");
                        }
                        database.exec("COMMIT");
                        return result;
                    } catch (error) {
                        database.exec("ROLLBACK");
                        throw error;
                    }
                },
            };
            return connection;
        },
    };
    return {
        capability,
        get closes() {
            return closes;
        },
        get opens() {
            return opens;
        },
        failNextCommit() {
            failCommit = true;
        },
    };
}
