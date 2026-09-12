import { isAbsolute } from "node:path";

import type { ExtensionAssetCapability, ExtensionContext } from "@portable-devshell/extension";

import type { AgentProviderRegistry } from "./AgentProviderRegistry.js";
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
    bundledProviders?: Readonly<Record<string, string>>;
    context: ExtensionContext;
    isProviderInUse(id: string): boolean;
    loader: AgentProviderLoader;
    registry: AgentProviderRegistry;
    store: AgentProviderRegistryStore;
}

export class AgentProviderManager {
    readonly #assets: ExtensionAssetCapability;
    readonly #bundledProviders: Readonly<Record<string, string>>;
    readonly #isProviderInUse: (id: string) => boolean;
    readonly #loader: AgentProviderLoader;
    readonly #registry: AgentProviderRegistry;
    readonly #store: AgentProviderRegistryStore;
    #mutation: Promise<void> = Promise.resolve();

    constructor(options: AgentProviderManagerOptions) {
        const assets = options.context.capabilities.assets;
        if (assets === undefined) throw new Error("Agent Extension requires the assets capability.");
        this.#assets = assets;
        this.#bundledProviders = options.bundledProviders ?? {};
        this.#isProviderInUse = options.isProviderInUse;
        this.#loader = options.loader;
        this.#registry = options.registry;
        this.#store = options.store;
    }

    async install(sourcePath: string): Promise<AgentProviderManagementRecord> {
        return await this.#exclusive(async () => await this.#install(sourcePath));
    }

    async installBundled(id: string): Promise<AgentProviderManagementRecord> {
        return await this.#exclusive(async () => {
            const before = await this.#store.read();
            const source = this.#bundledProviders[id];
            if (source === undefined) throw new Error(`Unknown bundled Agent provider: ${id}`);
            const existing = before.providers[id];
            if (existing === undefined) return await this.#install(source);

            const bundled = await this.#assets.installBundle(source);
            const candidate = await this.#loadInstalledCandidate(before, bundled.generation);
            if (candidate.manifest.id !== id) {
                return await this.#failCandidate(
                    before,
                    bundled.generation,
                    new Error(`Bundled Agent provider ${id} declares id ${candidate.manifest.id}.`),
                    id
                );
            }

            const current = await this.#record(id, existing);
            const runtimeReady = !existing.enabled || this.#registry.get(id) !== undefined;
            if (
                runtimeReady
                && current.version !== undefined
                && providerVersionAtLeast(current.version, candidate.manifest.version)
            ) {
                if (!registryReferencesGeneration(before, bundled.generation)) {
                    await this.#assets.removeBundle(bundled.generation);
                }
                if (before.defaultProvider === undefined && existing.enabled) {
                    const next = cloneAgentProviderRegistry(before);
                    next.defaultProvider = id;
                    await this.#store.write(next);
                    return await this.#record(id, next.providers[id]!);
                }
                return current;
            }

            return await this.#selectCandidate(before, bundled.generation, candidate, existing.enabled);
        });
    }

    bundledProviders(): readonly string[] {
        return Object.keys(this.#bundledProviders).sort();
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
                throw new Error(`Agent provider ${id} is not enabled and ready.`);
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
        if (snapshot.defaultProvider !== undefined && this.#registry.get(snapshot.defaultProvider) !== undefined) {
            return snapshot.defaultProvider;
        }
        const ready = this.#registry.list().map((provider) => provider.id).sort();
        if (ready.length === 1) return ready[0]!;
        if (ready.length === 0) {
            throw new Error("No enabled Agent provider is available. Install or enable a provider first.");
        }
        throw new Error(`Multiple Agent providers are enabled (${ready.join(", ")}). Select one with --provider or \`devshell agent provider default <id>\`.`);
    }

    async #install(sourcePath: string): Promise<AgentProviderManagementRecord> {
        if (!isAbsolute(sourcePath)) {
            throw new TypeError("Agent provider bundle path must be absolute. Use `agent provider install <id>` for bundled providers.");
        }
        const before = await this.#store.read();
        const bundle = await this.#assets.installBundle(sourcePath);
        const loaded = await this.#loadInstalledCandidate(before, bundle.generation);
        return await this.#selectCandidate(before, bundle.generation, loaded, true);
    }

    async #selectCandidate(
        before: AgentProviderRegistrySnapshot,
        generation: string,
        loaded: LoadedAgentProvider,
        enabled: boolean
    ): Promise<AgentProviderManagementRecord> {
        const manifest = loaded.manifest;
        const next = cloneAgentProviderRegistry(before);
        next.providers[manifest.id] = {
            enabled,
            lastKnownGoodGeneration: generation,
            selectedGeneration: generation
        };
        if (enabled) next.defaultProvider ??= manifest.id;
        try {
            await this.#store.write(next);
        } catch (error) {
            return await this.#failCandidate(before, generation, error, manifest.id);
        }
        if (!enabled) return recordFromLoaded(next.providers[manifest.id]!, loaded);
        try {
            this.#registry.replace(loaded.provider);
        } catch (error) {
            try {
                await this.#store.write(before);
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    `Agent provider ${manifest.id} runtime publish failed and registry rollback was incomplete.`
                );
            }
            return await this.#failCandidate(before, generation, error, manifest.id);
        }
        return recordFromLoaded(next.providers[manifest.id]!, loaded);
    }

    async list(): Promise<AgentProviderManagementRecord[]> {
        await this.#mutation;
        const snapshot = await this.#store.read();
        return await Promise.all(Object.entries(snapshot.providers)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(async ([id, entry]) => await this.#record(id, entry)));
    }

    async enable(id: string): Promise<AgentProviderManagementRecord> {
        return await this.#exclusive(async () => await this.#enable(id));
    }

    async #enable(id: string): Promise<AgentProviderManagementRecord> {
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
            try {
                await this.#store.write(before);
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    `Agent provider ${id} enable failed and registry rollback was incomplete.`
                );
            }
            throw error;
        }
        return recordFromLoaded(next.providers[id]!, loaded);
    }

    async disable(id: string): Promise<AgentProviderManagementRecord> {
        return await this.#exclusive(async () => await this.#disable(id));
    }

    async #disable(id: string): Promise<AgentProviderManagementRecord> {
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
    }

    async remove(id: string): Promise<{ id: string; removed: true }> {
        return await this.#exclusive(async () => await this.#remove(id));
    }

    async #remove(id: string): Promise<{ id: string; removed: true }> {
        const before = await this.#store.read();
        const entry = requireEntry(before, id);
        if (this.#isProviderInUse(id)) {
            throw new Error(`Agent provider ${id} is still in use by a running Agent.`);
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

        const generations = [...new Set([
            entry.selectedGeneration,
            entry.lastKnownGoodGeneration
        ].filter((generation): generation is string => generation !== undefined))];
        const settled = await Promise.allSettled(generations.map(async (generation) => {
            await this.#assets.removeBundle(generation);
        }));
        const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, `Agent provider ${id} was deregistered but bundle cleanup was incomplete.`);
        }
        return { id, removed: true };
    }

    async #loadInstalledCandidate(
        before: AgentProviderRegistrySnapshot,
        generation: string
    ): Promise<LoadedAgentProvider> {
        try {
            const manifest = await this.#loader.inspectBundle(generation);
            return await this.#loader.loadGeneration(manifest.id, generation);
        } catch (error) {
            return await this.#failCandidate(before, generation, error, "candidate");
        }
    }

    async #failCandidate(
        before: AgentProviderRegistrySnapshot,
        generation: string,
        error: unknown,
        id: string
    ): Promise<never> {
        if (registryReferencesGeneration(before, generation)) throw error;
        try {
            await this.#assets.removeBundle(generation);
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                `Agent provider ${id} candidate failed and bundle cleanup was incomplete.`
            );
        }
        throw error;
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

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#mutation;
        let release!: () => void;
        this.#mutation = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
            return await operation();
        } finally {
            release();
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

function registryReferencesGeneration(snapshot: AgentProviderRegistrySnapshot, generation: string): boolean {
    return Object.values(snapshot.providers).some((entry) =>
        entry.selectedGeneration === generation || entry.lastKnownGoodGeneration === generation
    );
}

function providerVersionAtLeast(current: string, bundled: string): boolean {
    if (current === bundled) return true;
    const left = parseComparableProviderVersion(current);
    const right = parseComparableProviderVersion(bundled);
    if (left === undefined || right === undefined) return true;
    const core = compareVersionCore(left, right);
    if (core !== 0) return core > 0;
    return comparePrerelease(left[3], right[3]) >= 0;
}

function compareVersionCore(
    left: [number, number, number, string[] | undefined],
    right: [number, number, number, string[] | undefined]
): number {
    if (left[0] !== right[0]) return left[0] > right[0] ? 1 : -1;
    if (left[1] !== right[1]) return left[1] > right[1] ? 1 : -1;
    if (left[2] !== right[2]) return left[2] > right[2] ? 1 : -1;
    return 0;
}

function parseComparableProviderVersion(value: string): [number, number, number, string[] | undefined] | undefined {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
    if (match === null) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.split(".")];
}

function comparePrerelease(left: string[] | undefined, right: string[] | undefined): number {
    if (left === undefined) return right === undefined ? 0 : 1;
    if (right === undefined) return -1;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const a = left[index];
        const b = right[index];
        if (a === undefined) return -1;
        if (b === undefined) return 1;
        if (a === b) continue;
        const aNumeric = /^\d+$/u.test(a);
        const bNumeric = /^\d+$/u.test(b);
        if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
        if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
        return a > b ? 1 : -1;
    }
    return 0;
}
