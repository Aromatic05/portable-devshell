import { readFile } from "node:fs/promises";
import type {
    ExtensionDatabaseCapability,
    ExtensionDatabaseConnection,
} from "@portable-devshell/extension/database";

import type {
    MessagePreferencesPatch,
    MessagePreferencesSnapshot,
} from "@portable-devshell/shared";

import {
    applyPatch,
    clonePreferences,
    createEmptyMessagePreferences,
    parseMessagePreferencesPatch,
    parseMessagePreferencesSnapshot,
    samePreferences,
} from "./Model.js";

export class MessagePreferenceStore {
    readonly #filePath: string;
    readonly #database: ExtensionDatabaseCapability;
    #connection?: ExtensionDatabaseConnection;
    #operationQueue = Promise.resolve();
    #closed = false;

    constructor(filePath: string, database: ExtensionDatabaseCapability) {
        this.#filePath = filePath;
        this.#database = database;
    }

    async read(): Promise<MessagePreferencesSnapshot> {
        return await this.#exclusive(async () => await this.#read());
    }

    async update(
        patch: MessagePreferencesPatch,
    ): Promise<MessagePreferencesSnapshot> {
        const normalized = parseMessagePreferencesPatch(patch);
        return await this.#exclusive(async () => {
            const database = await this.#open();
            return await database.transaction(async (connection) => {
                const row = await connection.get<{ value: string }>(
                    "SELECT value FROM message_preferences WHERE key = 'snapshot'",
                );
                if (row === undefined)
                    throw new Error("Message preference snapshot is missing.");
                const current = parseMessagePreferencesSnapshot(
                    JSON.parse(row.value) as unknown,
                );
                const next = applyPatch(current, normalized);
                if (samePreferences(current, next)) return current;
                await connection.run(
                    "UPDATE message_preferences SET value = ? WHERE key = 'snapshot'",
                    [JSON.stringify(next)],
                );
                return clonePreferences(next);
            });
        });
    }

    async close(): Promise<void> {
        await this.#exclusive(async () => {
            this.#closed = true;
            await this.#connection?.close();
            this.#connection = undefined;
        });
    }

    async #open(): Promise<ExtensionDatabaseConnection> {
        if (this.#closed)
            throw new Error("Message preference store is closed.");
        if (this.#connection !== undefined) return this.#connection;
        const database = await this.#database.open("message-preferences");
        try {
            await database.transaction(async (connection) => {
                await connection.exec(`
                    CREATE TABLE IF NOT EXISTS message_preferences (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    ) STRICT;
                `);
                const current = await connection.get<{ value: string }>(
                    "SELECT value FROM message_preferences WHERE key = 'snapshot'",
                );
                if (current !== undefined) {
                    parseMessagePreferencesSnapshot(
                        JSON.parse(current.value) as unknown,
                    );
                    return;
                }
                const source = await readFile(this.#filePath, "utf8").catch(
                    (error: unknown) => {
                        if (isMissing(error)) return undefined;
                        throw error;
                    },
                );
                const snapshot =
                    source === undefined
                        ? createEmptyMessagePreferences()
                        : parseMessagePreferencesSnapshot(
                              JSON.parse(source) as unknown,
                          );
                await connection.run(
                    "INSERT INTO message_preferences(key, value) VALUES ('snapshot', ?)",
                    [JSON.stringify(snapshot)],
                );
            });
            this.#connection = database;
            return database;
        } catch (error) {
            await database.close();
            throw error;
        }
    }

    async #read(): Promise<MessagePreferencesSnapshot> {
        const database = await this.#open();
        const row = await database.get<{ value: string }>(
            "SELECT value FROM message_preferences WHERE key = 'snapshot'",
        );
        if (row === undefined)
            throw new Error("Message preference snapshot is missing.");
        return parseMessagePreferencesSnapshot(
            JSON.parse(row.value) as unknown,
        );
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.#operationQueue.then(operation, operation);
        this.#operationQueue = next.then(
            () => undefined,
            () => undefined,
        );
        return await next;
    }
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
