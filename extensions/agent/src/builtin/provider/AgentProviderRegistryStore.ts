import { readFile } from "node:fs/promises";

import type { ExtensionContext } from "@portable-devshell/extension";

type DatabaseCapability = NonNullable<
    ExtensionContext["capabilities"]["database"]
>;
type DatabaseConnection = Awaited<ReturnType<DatabaseCapability["open"]>>;

export interface AgentProviderRegistryEntry {
    enabled: boolean;
    installedVersion?: string;
}

export interface AgentProviderRegistrySnapshot {
    defaultProvider?: string;
    providers: Record<string, AgentProviderRegistryEntry>;
    schemaVersion: 2;
}

export class AgentProviderRegistryStore {
    readonly #database: DatabaseCapability;
    readonly #legacyPath: string;
    #connection: DatabaseConnection | undefined;
    #operation: Promise<void> = Promise.resolve();
    #closed = false;

    constructor(database: DatabaseCapability, legacyPath: string) {
        this.#database = database;
        this.#legacyPath = legacyPath;
    }

    async read(): Promise<AgentProviderRegistrySnapshot> {
        return await this.#exclusive(async () => {
            const connection = await this.#open();
            const row = await connection.get<{ snapshot: string }>(
                "SELECT snapshot FROM provider_registry WHERE id = 1",
            );
            if (row === undefined) {
                throw new Error("Agent provider registry snapshot is missing.");
            }
            return parseAgentProviderRegistry(
                JSON.parse(row.snapshot) as unknown,
            );
        });
    }

    async write(snapshot: AgentProviderRegistrySnapshot): Promise<void> {
        const validated = parseAgentProviderRegistry(
            cloneAgentProviderRegistry(snapshot),
        );
        await this.#exclusive(async () => {
            const connection = await this.#open();
            await connection.transaction(async (transaction) => {
                await transaction.run(
                    "UPDATE provider_registry SET snapshot = ? WHERE id = 1",
                    [JSON.stringify(validated)],
                );
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

    async #open(): Promise<DatabaseConnection> {
        if (this.#closed)
            throw new Error("Agent provider registry store is closed.");
        if (this.#connection !== undefined) return this.#connection;
        const connection = await this.#database.open("providers");
        try {
            await connection.transaction(async (transaction) => {
                await transaction.exec(
                    "CREATE TABLE IF NOT EXISTS provider_registry (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)",
                );
                const existing = await transaction.get<{ snapshot: string }>(
                    "SELECT snapshot FROM provider_registry WHERE id = 1",
                );
                if (existing !== undefined) return;
                const source = await readFile(this.#legacyPath, "utf8").catch(
                    (error: unknown) => {
                        if (isMissing(error)) return undefined;
                        throw error;
                    },
                );
                const snapshot =
                    source === undefined
                        ? emptyAgentProviderRegistry()
                        : parseAgentProviderRegistry(
                              JSON.parse(source) as unknown,
                          );
                await transaction.run(
                    "INSERT INTO provider_registry (id, snapshot) VALUES (1, ?)",
                    [JSON.stringify(snapshot)],
                );
            });
        } catch (error) {
            await connection.close();
            throw error;
        }
        this.#connection = connection;
        return connection;
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.#operation.then(operation);
        this.#operation = result.then(
            () => undefined,
            () => undefined,
        );
        return await result;
    }
}

export function emptyAgentProviderRegistry(): AgentProviderRegistrySnapshot {
    return { providers: {}, schemaVersion: 2 };
}

export function cloneAgentProviderRegistry(
    snapshot: AgentProviderRegistrySnapshot,
): AgentProviderRegistrySnapshot {
    return {
        ...(snapshot.defaultProvider === undefined
            ? {}
            : { defaultProvider: snapshot.defaultProvider }),
        providers: Object.fromEntries(
            Object.entries(snapshot.providers).map(([id, entry]) => [
                id,
                { ...entry },
            ]),
        ),
        schemaVersion: 2,
    };
}

/**
 * Schema v1 contained dsprovider generation pointers. They are intentionally
 * discarded: the Provider remains known/enabled, but readiness is rediscovered
 * from the client runtime prefix (or a Provider-owned stable installation).
 */
export function parseAgentProviderRegistry(
    value: unknown,
): AgentProviderRegistrySnapshot {
    if (!isRecord(value) || !isRecord(value.providers)) {
        throw new TypeError("Agent provider registry is invalid.");
    }
    if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
        throw new TypeError("Agent provider registry is invalid.");
    }

    const providers: Record<string, AgentProviderRegistryEntry> = {};
    for (const [id, raw] of Object.entries(value.providers)) {
        assertProviderSegment(id, "id");
        if (!isRecord(raw) || typeof raw.enabled !== "boolean") {
            throw new TypeError(
                "Agent provider registry entry is invalid: " + id + ".",
            );
        }
        if (value.schemaVersion === 1) {
            const unknown = Object.keys(raw).find(
                (key) =>
                    key !== "enabled" &&
                    key !== "selectedGeneration" &&
                    key !== "lastKnownGoodGeneration",
            );
            if (unknown !== undefined) {
                throw new TypeError(
                    "Agent provider registry entry " +
                        id +
                        " has unknown field " +
                        unknown +
                        ".",
                );
            }
            providers[id] = { enabled: raw.enabled };
            continue;
        }

        const installedVersion =
            raw.installedVersion === undefined
                ? undefined
                : readVersion(raw.installedVersion, id);
        const unknown = Object.keys(raw).find(
            (key) => key !== "enabled" && key !== "installedVersion",
        );
        if (unknown !== undefined) {
            throw new TypeError(
                "Agent provider registry entry " +
                    id +
                    " has unknown field " +
                    unknown +
                    ".",
            );
        }
        providers[id] = {
            enabled: raw.enabled,
            ...(installedVersion === undefined ? {} : { installedVersion }),
        };
    }
    const defaultProvider =
        value.defaultProvider === undefined
            ? undefined
            : readProviderId(value.defaultProvider, "defaultProvider");
    return {
        ...(defaultProvider === undefined ? {} : { defaultProvider }),
        providers,
        schemaVersion: 2,
    };
}

export function assertProviderSegment(value: string, label: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
        throw new TypeError("Invalid Agent provider " + label + ": " + value);
    }
}

function readVersion(value: unknown, id: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(
            "Agent provider registry " +
                id +
                ".installedVersion must be a non-empty string.",
        );
    }
    return value;
}

function readProviderId(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new TypeError(
            "Agent provider registry " + field + " must be a string.",
        );
    }
    assertProviderSegment(value, field);
    return value;
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
