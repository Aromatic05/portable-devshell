import type { AgentProviderRegistry } from "@portable-devshell/agentd";
import type { ExtensionContext } from "@portable-devshell/extension";

import {
    AgentProviderLoader,
    type LoadedAgentProvider
} from "./AgentProviderLoader.js";
import {
    AgentProviderRegistryStore,
    cloneAgentProviderRegistry,
    type AgentProviderRegistryEntry,
    type AgentProviderRegistrySnapshot
} from "./AgentProviderRegistryStore.js";

export type AgentProviderManagementState = "disabled" | "invalid" | "ready" | "unselected";

export interface AgentProviderManagementRecord {
    enabled: boolean;
    error?: string;
    id: string;
    lastKnownGoodGeneration?: string;
    name?: string;
    selectedGeneration?: string;
    state: AgentProviderManagementState;
    version?: string;
}

export interface AgentProviderManagerOptions {
    context: ExtensionContext;
    isProviderInUse(id: string): boolean;
    loader: AgentProviderLoader;
    registry: AgentProviderRegistry;
    store: AgentProviderRegistryStore;
}

export class AgentProviderManager {
    readonly #context: ExtensionContext;
    readonly #isProviderInUse: (id: string) => boolean;
    readonly #loader: AgentProviderLoader;
    readonly #registry: AgentProviderRegistry;
    readonly #store: AgentProviderRegistryStore;

    constructor(options: AgentProviderManagerOptions) {
        this.#context = options.context;
        this.#isProviderInUse = options.isProviderInUse;
        this.#loader = options.loader;
        this.#registry = options.registry;
        this.#store = options.store;
    }

    async install(sourcePath: string): Promise<AgentProviderManagementRecord> {
        const bundle = await this.#context.assets.installBundle(sourcePath);
        const manifest = await this.#loader.inspectBundle(bundle.generation);
        const loaded = await this.#loader.loadGeneration(manifest.id, bundle.generation);
        const before = await this.#store.read();
        const next = cloneAgentProviderRegistry(before);
        next.providers[manifest.id] = {
            enabled: true,
            lastKnownGoodGeneration: bundle.generation,
            selectedGeneration: bundle.generation
        };
        await this.#store.write(next);
        try {
            this.#registry.replace(loaded.provider);
        } catch (error) {
            await this.#store.write(before).catch(() => undefined);
            throw error;
        }
        return recordFromLoaded(next.providers[manifest.id]!, loaded);
    }

    async list(): Promise<AgentProviderManagementRecord[]> {
        const snapshot = await this.#store.read();
        return await Promise.all(Object.entries(snapshot.providers)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(async ([id, entry]) => await this.#record(id, entry)));
    }

    async enable(id: string): Promise<AgentProviderManagementRecord> {
        const before = await this.#store.read();
        const entry = requireEntry(before, id);
        const loaded = await this.#loadPreferred(id, entry);
        const next = cloneAgentProviderRegistry(before);
        next.providers[id] = {
            ...entry,
            enabled: true,
            selectedGeneration: loaded.generation,
            lastKnownGoodGeneration: loaded.generation
        };
        await this.#store.write(next);
        try {
            this.#registry.replace(loaded.provider);
        } catch (error) {
            await this.#store.write(before).catch(() => undefined);
            throw error;
        }
        return recordFromLoaded(next.providers[id]!, loaded);
    }

    async disable(id: string): Promise<AgentProviderManagementRecord> {
        const before = await this.#store.read();
        const entry = requireEntry(before, id);
        const next = cloneAgentProviderRegistry(before);
        next.providers[id] = { ...entry, enabled: false };
        await this.#store.write(next);
        this.#registry.unregister(id);
        return await this.#record(id, next.providers[id]!);
    }

    async remove(id: string): Promise<{ id: string; removed: true }> {
        if (this.#isProviderInUse(id)) {
            throw new Error(`Agent provider ${id} is still in use by a running Agent.`);
        }
        const before = await this.#store.read();
        const entry = requireEntry(before, id);
        const next = cloneAgentProviderRegistry(before);
        delete next.providers[id];
        await this.#store.write(next);
        this.#registry.unregister(id);

        const generations = [...new Set([
            entry.selectedGeneration,
            entry.lastKnownGoodGeneration
        ].filter((generation): generation is string => generation !== undefined))];
        const settled = await Promise.allSettled(generations.map(async (generation) => {
            await this.#context.assets.removeBundle(generation);
        }));
        const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, `Agent provider ${id} was deregistered but bundle cleanup was incomplete.`);
        }
        return { id, removed: true };
    }

    async #loadPreferred(id: string, entry: AgentProviderRegistryEntry): Promise<LoadedAgentProvider> {
        const candidates = [...new Set([
            entry.selectedGeneration,
            entry.lastKnownGoodGeneration
        ].filter((generation): generation is string => generation !== undefined))];
        let lastFailure: unknown;
        for (const generation of candidates) {
            try {
                return await this.#loader.loadGeneration(id, generation);
            } catch (error) {
                lastFailure = error;
            }
        }
        if (lastFailure !== undefined) throw lastFailure;
        throw new Error(`Agent provider ${id} has no selected generation.`);
    }

    async #record(id: string, entry: AgentProviderRegistryEntry): Promise<AgentProviderManagementRecord> {
        const generation = entry.selectedGeneration ?? entry.lastKnownGoodGeneration;
        if (generation === undefined) {
            return {
                enabled: entry.enabled,
                id,
                state: entry.enabled ? "unselected" : "disabled"
            };
        }
        try {
            const manifest = await this.#loader.inspectGeneration(id, generation);
            return {
                enabled: entry.enabled,
                id,
                ...(entry.lastKnownGoodGeneration === undefined ? {} : { lastKnownGoodGeneration: entry.lastKnownGoodGeneration }),
                name: manifest.name,
                ...(entry.selectedGeneration === undefined ? {} : { selectedGeneration: entry.selectedGeneration }),
                state: entry.enabled ? "ready" : "disabled",
                version: manifest.version
            };
        } catch (error) {
            return {
                enabled: entry.enabled,
                error: error instanceof Error ? error.message : String(error),
                id,
                ...(entry.lastKnownGoodGeneration === undefined ? {} : { lastKnownGoodGeneration: entry.lastKnownGoodGeneration }),
                ...(entry.selectedGeneration === undefined ? {} : { selectedGeneration: entry.selectedGeneration }),
                state: entry.enabled ? "invalid" : "disabled"
            };
        }
    }
}

function recordFromLoaded(
    entry: AgentProviderRegistryEntry,
    loaded: LoadedAgentProvider
): AgentProviderManagementRecord {
    return {
        enabled: entry.enabled,
        id: loaded.manifest.id,
        ...(entry.lastKnownGoodGeneration === undefined ? {} : { lastKnownGoodGeneration: entry.lastKnownGoodGeneration }),
        name: loaded.manifest.name,
        ...(entry.selectedGeneration === undefined ? {} : { selectedGeneration: entry.selectedGeneration }),
        state: entry.enabled ? "ready" : "disabled",
        version: loaded.manifest.version
    };
}

function requireEntry(snapshot: AgentProviderRegistrySnapshot, id: string): AgentProviderRegistryEntry {
    const entry = snapshot.providers[id];
    if (entry !== undefined) return entry;
    throw new Error(`Unknown Agent provider: ${id}`);
}
