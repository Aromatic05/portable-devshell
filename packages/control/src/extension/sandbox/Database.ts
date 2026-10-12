import type {
    ExtensionDatabaseCapability,
    ExtensionDatabaseConnection,
    ExtensionSqlCommand,
    ExtensionSqlRow,
    ExtensionSqlValue,
} from "@portable-devshell/extension/database";

import type { ExtensionSandboxCapabilityOperation } from "./bridge/Protocol.js";

type Request = (
    operation: ExtensionSandboxCapabilityOperation,
    input: unknown,
) => Promise<unknown>;

/** A JSON-only projection of the Host's database connection lease. */
export function createSandboxDatabaseCapability(
    request: Request,
): ExtensionDatabaseCapability {
    return Object.freeze({
        open: async (name: string): Promise<ExtensionDatabaseConnection> => {
            const id = await request("database.open", { name });
            if (typeof id !== "string")
                throw new Error("Invalid Host database handle.");
            let closed = false;
            let queue: Promise<unknown> = Promise.resolve();

            const command = async (
                input: ExtensionSqlCommand,
                token?: string,
            ) =>
                await request("database.execute", {
                    id,
                    ...input,
                    ...(token === undefined ? {} : { transaction: token }),
                });
            const context = (token?: string): ExtensionDatabaseConnection => ({
                all: async <T extends ExtensionSqlRow>(
                    sql: string,
                    parameters?: readonly ExtensionSqlValue[],
                ) =>
                    (await command(
                        {
                            mode: "all",
                            sql,
                            ...(parameters === undefined ? {} : { parameters }),
                        },
                        token,
                    )) as T[],
                close: async () => {
                    throw new Error(
                        "Database transaction cannot close its connection.",
                    );
                },
                exec: async (sql: string) => {
                    await command({ mode: "exec", sql }, token);
                },
                get: async <T extends ExtensionSqlRow>(
                    sql: string,
                    parameters?: readonly ExtensionSqlValue[],
                ) =>
                    ((await command(
                        {
                            mode: "get",
                            sql,
                            ...(parameters === undefined ? {} : { parameters }),
                        },
                        token,
                    )) as T | null) ?? undefined,
                run: async (
                    sql: string,
                    parameters?: readonly ExtensionSqlValue[],
                ) =>
                    (
                        (await command(
                            {
                                mode: "run",
                                sql,
                                ...(parameters === undefined
                                    ? {}
                                    : { parameters }),
                            },
                            token,
                        )) as { changes: number }
                    ).changes,
                transaction: async () => {
                    throw new Error(
                        "Nested database transactions are not supported.",
                    );
                },
            });
            const base = context();
            const serial = <T>(job: () => Promise<T>): Promise<T> => {
                if (closed)
                    return Promise.reject(
                        new Error("Database connection is closed."),
                    );
                const result = queue.then(job);
                queue = result.catch(() => undefined);
                return result;
            };
            return Object.freeze({
                all: async <T extends ExtensionSqlRow>(
                    sql: string,
                    parameters?: readonly ExtensionSqlValue[],
                ) => serial(async () => await base.all<T>(sql, parameters)),
                close: async () => {
                    if (closed) return;
                    closed = true;
                    await queue;
                    await request("database.close", { id });
                },
                exec: async (sql: string) =>
                    serial(async () => await base.exec(sql)),
                get: async <T extends ExtensionSqlRow>(
                    sql: string,
                    parameters?: readonly ExtensionSqlValue[],
                ) => serial(async () => await base.get<T>(sql, parameters)),
                run: async (
                    sql: string,
                    parameters?: readonly ExtensionSqlValue[],
                ) => serial(async () => await base.run(sql, parameters)),
                transaction: async <T>(
                    operation: (
                        connection: ExtensionDatabaseConnection,
                    ) => Promise<T>,
                ) =>
                    serial(async () => {
                        const token = await request("database.begin", { id });
                        if (typeof token !== "string")
                            throw new Error(
                                "Invalid Host database transaction lease.",
                            );
                        let result: T;
                        try {
                            result = await operation(context(token));
                        } catch (error) {
                            try {
                                await request("database.end", {
                                    id,
                                    transaction: token,
                                    commit: false,
                                });
                            } catch (rollbackError) {
                                throw new AggregateError(
                                    [error, rollbackError],
                                    "Database operation failed and rollback was incomplete.",
                                );
                            }
                            throw error;
                        }
                        await request("database.end", {
                            id,
                            transaction: token,
                            commit: true,
                        });
                        return result;
                    }),
            });
        },
    });
}
