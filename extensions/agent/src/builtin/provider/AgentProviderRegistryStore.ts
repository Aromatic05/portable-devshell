import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

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
    readonly #path: string;

    constructor(path: string) {
        this.#path = path;
    }

    async read(): Promise<AgentProviderRegistrySnapshot> {
        const source = await readFile(this.#path, "utf8").catch(
            (error: unknown) => {
                if (isMissing(error)) return undefined;
                throw error;
            },
        );
        if (source === undefined) return emptyAgentProviderRegistry();
        return parseAgentProviderRegistry(JSON.parse(source) as unknown);
    }

    async write(snapshot: AgentProviderRegistrySnapshot): Promise<void> {
        const validated = parseAgentProviderRegistry(
            cloneAgentProviderRegistry(snapshot),
        );
        const directory = dirname(this.#path);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary =
            this.#path + "." + process.pid + "." + randomUUID() + ".tmp";
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(
                JSON.stringify(validated, null, 2) + "\n",
                "utf8",
            );
            await handle.sync();
        } catch (error) {
            await handle.close().catch(() => undefined);
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        await handle.close();
        try {
            await rename(temporary, this.#path);
            if (process.platform !== "win32") {
                const directoryHandle = await open(directory, "r");
                try {
                    await directoryHandle.sync();
                } finally {
                    await directoryHandle.close();
                }
            }
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
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
