import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { constants, DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
    ExtensionDatabaseCapability,
    ExtensionDatabaseConnection,
    ExtensionSqlCommand,
    ExtensionSqlRow,
    ExtensionSqlValue,
} from "@portable-devshell/extension/database";

type Handle = {
    allowTransaction: boolean;
    database: DatabaseSync;
    transaction?: string;
};

/**
 * Host-owned, generation-scoped SQLite leases. No caller supplies an absolute path.
 * All handles are closed (and uncommitted transactions rolled back) on retirement.
 */
export class ExtensionDatabaseCapabilityControl implements ExtensionDatabaseCapability {
    readonly #allowed: boolean;
    readonly #dataDirectory: string;
    readonly #extensionId: string;
    readonly #handles = new Map<string, Handle>();
    #closed = false;

    constructor(options: {
        allowed: boolean;
        dataDirectory: string;
        extensionId: string;
    }) {
        this.#allowed = options.allowed;
        this.#dataDirectory = options.dataDirectory;
        this.#extensionId = options.extensionId;
    }

    async open(name: string): Promise<ExtensionDatabaseConnection> {
        const id = await this.openHandle(name);
        return connectionFacade(this, id);
    }

    async openHandle(name: string): Promise<string> {
        this.#requireAvailable();
        const file = await this.#resolveFile(name);
        this.#requireAvailable();
        const database = new DatabaseSync(file, { timeout: 5_000 });
        const handle: Handle = { allowTransaction: false, database };
        try {
            // Both enforcement APIs are required; older Node 24 runtimes
            // must not silently execute SQL without the requested isolation.
            if (
                typeof database.setAuthorizer !== "function" ||
                typeof database.enableDefensive !== "function"
            ) {
                throw new Error(
                    "Extension Database Capability requires Node.js v24.12.0 or later.",
                );
            }
            // SQL can contain ATTACH/VACUUM INTO or explicit transaction control
            // regardless of its invocation mode. Enforce scope in SQLite itself.
            database.setAuthorizer((action) => {
                if (
                    action === constants.SQLITE_ATTACH ||
                    action === constants.SQLITE_DETACH ||
                    action === constants.SQLITE_SAVEPOINT ||
                    (action === constants.SQLITE_TRANSACTION &&
                        !handle.allowTransaction)
                )
                    return constants.SQLITE_DENY;
                return constants.SQLITE_OK;
            });
            database.enableDefensive(true);
        } catch (error) {
            database.close();
            throw error;
        }
        const id = randomUUID();
        this.#handles.set(id, handle);
        return id;
    }

    execute(
        id: string,
        command: ExtensionSqlCommand,
        transaction?: string,
    ): ExtensionSqlRow | ExtensionSqlRow[] | { changes: number } | null {
        const handle = this.#requireHandle(id);
        if (handle.transaction !== transaction)
            throw new Error(
                "Database transaction lease is not owned by this request.",
            );
        if (typeof command?.sql !== "string" || command.sql.length === 0)
            throw new TypeError("Database SQL must be a non-empty string.");
        const values = checkedValues(command.parameters);
        switch (command.mode) {
            case "exec":
                if (values.length !== 0)
                    throw new TypeError(
                        "Database exec does not accept parameters.",
                    );
                handle.database.exec(command.sql);
                return null;
            case "run": {
                const result = handle.database
                    .prepare(command.sql)
                    .run(...values);
                const changes = Number(result.changes);
                if (!Number.isSafeInteger(changes))
                    throw new RangeError(
                        "Database affected-row count exceeds safe integer range.",
                    );
                return { changes };
            }
            case "get":
                return readRow(
                    handle.database.prepare(command.sql).get(...values),
                );
            case "all":
                return handle.database
                    .prepare(command.sql)
                    .all(...values)
                    .map(readRow) as ExtensionSqlRow[];
            default:
                throw new TypeError("Unsupported database command mode.");
        }
    }

    begin(id: string): string {
        const handle = this.#requireHandle(id);
        if (handle.transaction !== undefined)
            throw new Error("Database transaction is already active.");
        const token = randomUUID();
        this.#transactionSql(handle, "BEGIN IMMEDIATE");
        handle.transaction = token;
        return token;
    }

    end(id: string, transaction: string, commit: boolean): void {
        const handle = this.#requireHandle(id);
        if (!transaction || handle.transaction !== transaction)
            throw new Error("Database transaction lease is invalid.");
        try {
            this.#transactionSql(handle, commit ? "COMMIT" : "ROLLBACK");
        } catch (error) {
            // SQLite can leave a transaction open after a failed COMMIT.
            // Do not return that connection to the Extension: force-close it.
            this.#handles.delete(id);
            const failures: unknown[] = [error];
            try {
                this.#transactionSql(handle, "ROLLBACK");
            } catch (rollbackError) {
                failures.push(rollbackError);
            }
            try {
                handle.database.close();
            } catch (closeError) {
                failures.push(closeError);
            }
            if (failures.length > 1)
                throw new AggregateError(
                    failures,
                    "Database transaction failed and connection recovery was incomplete.",
                );
            throw error;
        } finally {
            handle.transaction = undefined;
        }
    }

    closeHandle(id: string): void {
        const handle = this.#requireHandle(id);
        this.#handles.delete(id);
        try {
            if (handle.transaction !== undefined)
                this.#transactionSql(handle, "ROLLBACK");
        } finally {
            handle.database.close();
        }
    }

    closeAll(): void {
        if (this.#closed) return;
        const ids = [...this.#handles.keys()];
        const failures: unknown[] = [];
        try {
            for (const id of ids) {
                try {
                    this.closeHandle(id);
                } catch (error) {
                    failures.push(error);
                }
            }
        } finally {
            this.#closed = true;
        }
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                "One or more Extension database connections failed to close.",
            );
    }

    #transactionSql(handle: Handle, statement: string): void {
        handle.allowTransaction = true;
        try {
            handle.database.exec(statement);
        } finally {
            handle.allowTransaction = false;
        }
    }

    #requireAvailable(): void {
        if (!this.#allowed)
            throw new Error(
                `Extension ${this.#extensionId} has no database capability.`,
            );
        if (this.#closed)
            throw new Error("Extension database generation is closed.");
    }

    #requireHandle(id: string): Handle {
        this.#requireAvailable();
        const handle = this.#handles.get(id);
        if (handle === undefined)
            throw new Error("Unknown or retired Extension database handle.");
        return handle;
    }

    async #resolveFile(name: string): Promise<string> {
        if (
            typeof name !== "string" ||
            name.length < 1 ||
            name.length > 200 ||
            name
                .split("/")
                .some(
                    (part) =>
                        !/^[a-zA-Z0-9_%][a-zA-Z0-9_.%-]*$/u.test(part) ||
                        part === "..",
                )
        ) {
            throw new TypeError(
                "Extension database name must contain safe relative segments.",
            );
        }
        const root = await realpath(this.#dataDirectory);
        const parent = join(root, ...name.split("/").slice(0, -1));
        const parts = name.split("/");
        let directory = root;
        for (const part of parts.slice(0, -1)) {
            directory = join(directory, part);
            await mkdir(directory, { mode: 0o700 }).catch(
                (error: NodeJS.ErrnoException) => {
                    if (error.code !== "EEXIST") throw error;
                },
            );
            const entry = await lstat(directory);
            if (!entry.isDirectory() || entry.isSymbolicLink())
                throw new Error(
                    "Extension database directory is not a plain directory.",
                );
        }
        if (parent !== root && !parent.startsWith(root + sep))
            throw new Error(
                "Extension database path escapes its data directory.",
            );
        const file = join(parent, parts.at(-1)! + ".sqlite3");
        const existing = await lstat(file).catch(
            (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
            },
        );
        if (
            existing !== undefined &&
            (!existing.isFile() || existing.isSymbolicLink())
        )
            throw new Error("Extension database file is not a plain file.");
        return file;
    }
}

function checkedValues(
    input: readonly ExtensionSqlValue[] | undefined,
): SQLInputValue[] {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 4096)
        throw new TypeError("Database parameters must be a bounded array.");
    return input.map((value) => {
        if (value === null || typeof value === "string") return value;
        if (
            typeof value === "number" &&
            Number.isFinite(value) &&
            Math.abs(value) <= Number.MAX_SAFE_INTEGER
        )
            return value;
        throw new TypeError(
            "Database parameter must be a finite safe-range number, string, or null.",
        );
    });
}

function readRow(input: unknown): ExtensionSqlRow | null {
    if (input === undefined) return null;
    if (input === null || typeof input !== "object" || Array.isArray(input))
        throw new TypeError("Invalid SQLite row.");
    const row: ExtensionSqlRow = {};
    for (const [key, value] of Object.entries(input)) {
        if (value === null || typeof value === "string") row[key] = value;
        else if (
            typeof value === "number" &&
            Number.isFinite(value) &&
            Math.abs(value) <= Number.MAX_SAFE_INTEGER
        )
            row[key] = value;
        else if (
            typeof value === "bigint" &&
            Number.isSafeInteger(Number(value))
        )
            row[key] = Number(value);
        else throw new TypeError(`Unsupported SQLite result in column ${key}.`);
    }
    return row;
}

function connectionFacade(
    runtime: ExtensionDatabaseCapabilityControl,
    id: string,
): ExtensionDatabaseConnection {
    let closed = false;
    let tail: Promise<unknown> = Promise.resolve();
    const direct = (command: ExtensionSqlCommand, transaction?: string) =>
        runtime.execute(id, command, transaction);
    const serial = <T>(job: () => Promise<T>): Promise<T> => {
        if (closed)
            return Promise.reject(new Error("Database connection is closed."));
        const result = tail.then(job);
        tail = result.catch(() => undefined);
        return result;
    };
    const queries = (token?: string): ExtensionDatabaseConnection => ({
        all: async <T extends ExtensionSqlRow>(
            sql: string,
            parameters?: readonly ExtensionSqlValue[],
        ) =>
            direct(
                {
                    mode: "all",
                    sql,
                    ...(parameters === undefined ? {} : { parameters }),
                },
                token,
            ) as T[],
        close: async () => {
            throw new Error(
                "Cannot close a transaction-bound database connection.",
            );
        },
        exec: async (sql: string) => {
            direct({ mode: "exec", sql }, token);
        },
        get: async <T extends ExtensionSqlRow>(
            sql: string,
            parameters?: readonly ExtensionSqlValue[],
        ) =>
            (direct(
                {
                    mode: "get",
                    sql,
                    ...(parameters === undefined ? {} : { parameters }),
                },
                token,
            ) as T | null) ?? undefined,
        run: async (sql: string, parameters?: readonly ExtensionSqlValue[]) =>
            (
                direct(
                    {
                        mode: "run",
                        sql,
                        ...(parameters === undefined ? {} : { parameters }),
                    },
                    token,
                ) as { changes: number }
            ).changes,
        transaction: async () => {
            throw new Error("Nested database transactions are not supported.");
        },
    });
    const base = queries();
    return {
        all: async <T extends ExtensionSqlRow>(
            sql: string,
            params?: readonly ExtensionSqlValue[],
        ) => serial(async () => base.all<T>(sql, params)),
        close: async () => {
            if (closed) return;
            closed = true;
            await tail;
            runtime.closeHandle(id);
        },
        exec: async (sql: string) => serial(async () => base.exec(sql)),
        get: async <T extends ExtensionSqlRow>(
            sql: string,
            params?: readonly ExtensionSqlValue[],
        ) => serial(async () => base.get<T>(sql, params)),
        run: async (sql: string, params?: readonly ExtensionSqlValue[]) =>
            serial(async () => base.run(sql, params)),
        transaction: async <T>(
            operation: (database: ExtensionDatabaseConnection) => Promise<T>,
        ) =>
            serial(async () => {
                const token = runtime.begin(id);
                let result: T;
                try {
                    result = await operation(queries(token));
                } catch (error) {
                    try {
                        runtime.end(id, token, false);
                    } catch (rollbackError) {
                        throw new AggregateError(
                            [error, rollbackError],
                            "Database operation failed and rollback was incomplete.",
                        );
                    }
                    throw error;
                }
                runtime.end(id, token, true);
                return result;
            }),
    };
}
