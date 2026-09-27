import type { AgentProvider } from "./AgentProvider.js";
import type { AgentProviderRegistry } from "./AgentProviderRegistry.js";
import {
    AgentProviderRegistryStore,
    cloneAgentProviderRegistry,
    type AgentProviderRegistryEntry,
    type AgentProviderRegistrySnapshot,
} from "./AgentProviderRegistryStore.js";
import { AgentProviderRuntimePaths } from "./AgentProviderRuntimePaths.js";

export type AgentProviderManagementState =
    | "disabled"
    | "invalid"
    | "ready"
    | "uninstalled";

export interface AgentProviderManagementRecord {
    enabled: boolean;
    error?: string;
    id: string;
    installedVersion?: string;
    name?: string;
    state: AgentProviderManagementState;
    version?: string;
}

export interface AgentProviderDefinition {
    create(): AgentProvider;
    id: string;
    install(
        runtime: AgentProviderRuntimePaths,
        options?: { force?: boolean },
    ): Promise<void>;
    isInstalled(runtime: AgentProviderRuntimePaths): Promise<boolean>;
    name: string;
    remove(runtime: AgentProviderRuntimePaths): Promise<void>;
    version: string;
}

export interface AgentProviderManagerOptions {
    definitions: readonly AgentProviderDefinition[];
    isProviderInUse(id: string): boolean;
    registry: AgentProviderRegistry;
    runtimeRootDirectory: string;
    store: AgentProviderRegistryStore;
}

export class AgentProviderManager {
    readonly #definitions = new Map<string, AgentProviderDefinition>();
    readonly #isProviderInUse: (id: string) => boolean;
    readonly #registry: AgentProviderRegistry;
    readonly #runtimeRootDirectory: string;
    readonly #store: AgentProviderRegistryStore;
    #mutation: Promise<void> = Promise.resolve();

    constructor(options: AgentProviderManagerOptions) {
        for (const definition of options.definitions) {
            if (this.#definitions.has(definition.id)) {
                throw new Error(
                    "Agent provider definition already registered: " +
                        definition.id,
                );
            }
            this.#definitions.set(definition.id, definition);
        }
        this.#isProviderInUse = options.isProviderInUse;
        this.#registry = options.registry;
        this.#runtimeRootDirectory = options.runtimeRootDirectory;
        this.#store = options.store;
    }

    async initialize(): Promise<void> {
        await this.#exclusive(async () => {
            const snapshot = await this.#store.read();
            for (const [id, entry] of Object.entries(snapshot.providers)) {
                if (!entry.enabled) continue;
                const definition = this.#definitions.get(id);
                if (definition === undefined) continue;
                const runtime = this.#runtime(definition);
                if (!(await definition.isInstalled(runtime))) continue;
                this.#registry.replace(definition.create());
            }
        });
    }

    availableProviders(): readonly string[] {
        return [...this.#definitions.keys()].sort();
    }

    async install(
        id: string,
        options: { force?: boolean } = {},
    ): Promise<AgentProviderManagementRecord> {
        return await this.#exclusive(async () => {
            const definition = this.#requireDefinition(id);
            if (options.force === true && this.#isProviderInUse(id)) {
                throw new Error(
                    "Agent provider " +
                        id +
                        " is still in use by a running Agent.",
                );
            }
            const runtime = this.#runtime(definition);
            await definition.install(runtime, options);
            if (!(await definition.isInstalled(runtime))) {
                throw new Error(
                    "Agent provider " +
                        id +
                        " installation completed without a usable runtime.",
                );
            }

            const before = await this.#store.read();
            const existing = before.providers[id];
            const enabled = existing?.enabled ?? true;
            const provider = definition.create();
            assertProviderMatchesDefinition(provider, definition);
            const previousRuntime = this.#registry.get(id);
            if (enabled) this.#registry.replace(provider);
            else this.#registry.unregister(id);

            const next = cloneAgentProviderRegistry(before);
            next.providers[id] = {
                enabled,
                installedVersion: definition.version,
            };
            if (enabled) next.defaultProvider ??= id;
            try {
                await this.#store.write(next);
            } catch (error) {
                this.#registry.unregister(id);
                if (previousRuntime !== undefined) {
                    this.#registry.replace(previousRuntime);
                }
                throw error;
            }
            return await this.#record(id, next.providers[id]!);
        });
    }

    async update(id: string): Promise<AgentProviderManagementRecord> {
        return await this.install(id, { force: true });
    }

    async list(): Promise<AgentProviderManagementRecord[]> {
        await this.#mutation;
        const snapshot = await this.#store.read();
        const ids = new Set([
            ...this.#definitions.keys(),
            ...Object.keys(snapshot.providers),
        ]);
        return await Promise.all(
            [...ids]
                .sort((left, right) => left.localeCompare(right))
                .map(
                    async (id) =>
                        await this.#record(id, snapshot.providers[id]),
                ),
        );
    }

    async getDefault(): Promise<string | undefined> {
        await this.#mutation;
        return (await this.#store.read()).defaultProvider;
    }

    async setDefault(id: string): Promise<string> {
        return await this.#exclusive(async () => {
            const before = await this.#store.read();
            const entry = requireEntry(before, id);
            if (!entry.enabled || this.#registry.get(id) === undefined) {
                throw new Error(
                    "Agent provider " + id + " is not enabled and ready.",
                );
            }
            const next = cloneAgentProviderRegistry(before);
            next.defaultProvider = id;
            await this.#store.write(next);
            return id;
        });
    }

    async resolveProvider(requested?: string): Promise<string> {
        await this.#mutation;
        if (requested !== undefined) {
            this.#registry.require(requested);
            return requested;
        }
        const snapshot = await this.#store.read();
        if (
            snapshot.defaultProvider !== undefined &&
            this.#registry.get(snapshot.defaultProvider) !== undefined
        ) {
            return snapshot.defaultProvider;
        }
        const ready = this.#registry
            .list()
            .map((provider) => provider.id)
            .sort();
        if (ready.length === 1) return ready[0]!;
        if (ready.length === 0) {
            throw new Error(
                "No enabled Agent provider is available. Install or enable a provider first.",
            );
        }
        throw new Error(
            "Multiple Agent providers are enabled (" +
                ready.join(", ") +
                "). Select one with --provider or devshell agent provider default <id>.",
        );
    }

    async enable(id: string): Promise<AgentProviderManagementRecord> {
        return await this.#exclusive(async () => {
            const before = await this.#store.read();
            const entry = requireEntry(before, id);
            const definition = this.#requireDefinition(id);
            const runtime = this.#runtime(definition);
            if (!(await definition.isInstalled(runtime))) {
                throw new Error(
                    "Agent provider " +
                        id +
                        " is not installed. Run devshell agent provider install " +
                        id +
                        " first.",
                );
            }
            const provider = definition.create();
            assertProviderMatchesDefinition(provider, definition);
            const next = cloneAgentProviderRegistry(before);
            next.providers[id] = {
                enabled: true,
                installedVersion: definition.version,
            };
            await this.#store.write(next);
            try {
                this.#registry.replace(provider);
            } catch (error) {
                await this.#store.write(before).catch((rollbackError) => {
                    throw new AggregateError(
                        [error, rollbackError],
                        "Agent provider " +
                            id +
                            " enable failed and registry rollback was incomplete.",
                    );
                });
                throw error;
            }
            return await this.#record(id, next.providers[id]!);
        });
    }

    async disable(id: string): Promise<AgentProviderManagementRecord> {
        return await this.#exclusive(async () => {
            const before = await this.#store.read();
            const entry = requireEntry(before, id);
            const next = cloneAgentProviderRegistry(before);
            next.providers[id] = { ...entry, enabled: false };
            const provider = this.#registry.unregister(id);
            try {
                await this.#store.write(next);
            } catch (error) {
                if (provider !== undefined) this.#registry.replace(provider);
                throw error;
            }
            return await this.#record(id, next.providers[id]!);
        });
    }

    async remove(id: string): Promise<{ id: string; removed: true }> {
        return await this.#exclusive(async () => {
            const before = await this.#store.read();
            requireEntry(before, id);
            const definition = this.#requireDefinition(id);
            if (this.#isProviderInUse(id)) {
                throw new Error(
                    "Agent provider " +
                        id +
                        " is still in use by a running Agent.",
                );
            }
            const next = cloneAgentProviderRegistry(before);
            delete next.providers[id];
            if (next.defaultProvider === id) delete next.defaultProvider;
            const provider = this.#registry.unregister(id);
            try {
                await this.#store.write(next);
            } catch (error) {
                if (provider !== undefined) this.#registry.replace(provider);
                throw error;
            }
            try {
                await definition.remove(this.#runtime(definition));
            } catch (error) {
                throw new Error(
                    "Agent provider " +
                        id +
                        " was deregistered but client runtime cleanup failed.",
                    { cause: error },
                );
            }
            return { id, removed: true };
        });
    }

    async #record(
        id: string,
        entry: AgentProviderRegistryEntry | undefined,
    ): Promise<AgentProviderManagementRecord> {
        const definition = this.#definitions.get(id);
        if (definition === undefined) {
            return {
                enabled: entry?.enabled ?? false,
                error: "Provider is not supported by this Agent Extension.",
                id,
                ...(entry?.installedVersion === undefined
                    ? {}
                    : { installedVersion: entry.installedVersion }),
                state: "invalid",
            };
        }
        try {
            const installed = await definition.isInstalled(
                this.#runtime(definition),
            );
            if (!installed) {
                return {
                    enabled: entry?.enabled ?? false,
                    id,
                    name: definition.name,
                    state: "uninstalled",
                    version: definition.version,
                };
            }
            return {
                enabled: entry?.enabled ?? false,
                id,
                installedVersion:
                    entry?.installedVersion ?? definition.version,
                name: definition.name,
                state: entry?.enabled === true ? "ready" : "disabled",
                version: definition.version,
            };
        } catch (error) {
            return {
                enabled: entry?.enabled ?? false,
                error: error instanceof Error ? error.message : String(error),
                id,
                ...(entry?.installedVersion === undefined
                    ? {}
                    : { installedVersion: entry.installedVersion }),
                name: definition.name,
                state: "invalid",
                version: definition.version,
            };
        }
    }

    #runtime(definition: AgentProviderDefinition): AgentProviderRuntimePaths {
        return new AgentProviderRuntimePaths({
            provider: definition.id,
            rootDirectory: this.#runtimeRootDirectory,
            version: definition.version,
        });
    }

    #requireDefinition(id: string): AgentProviderDefinition {
        const definition = this.#definitions.get(id);
        if (definition !== undefined) return definition;
        throw new Error("Unknown Agent provider: " + id);
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#mutation;
        let release!: () => void;
        this.#mutation = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function requireEntry(
    snapshot: AgentProviderRegistrySnapshot,
    id: string,
): AgentProviderRegistryEntry {
    const entry = snapshot.providers[id];
    if (entry !== undefined) return entry;
    throw new Error("Unknown Agent provider: " + id);
}

function assertProviderMatchesDefinition(
    provider: AgentProvider,
    definition: AgentProviderDefinition,
): void {
    if (provider.id !== definition.id || provider.version !== definition.version) {
        throw new Error(
            "Agent provider definition " +
                definition.id +
                " created incompatible runtime " +
                provider.id +
                "@" +
                provider.version +
                ".",
        );
    }
}
