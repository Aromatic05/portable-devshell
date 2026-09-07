import type {
    ExtensionCommandResult,
    ExtensionInstanceRetireEvent,
    ExtensionJsonValue
} from "@portable-devshell/extension";

import { ExtensionGeneration, type ExtensionGenerationLease } from "./ExtensionGeneration.js";
import {
    cloneExtensionRegistry,
    type ExtensionRegistryEntry,
    type ExtensionRegistrySnapshot
} from "./ExtensionRegistryModel.js";
import type { ExtensionRegistryPort } from "./ExtensionRegistryStore.js";

export interface ExtensionGenerationLoader {
    load(id: string, generation: string): Promise<ExtensionGeneration>;
}

export interface ExtensionRuntimeRetiredRecord {
    generation: string;
    inFlight: number;
    state: ExtensionGeneration["state"];
}

export interface ExtensionRuntimeRecord {
    activeGeneration?: string;
    enabled: boolean;
    failure?: {
        generation?: string;
        message: string;
    };
    id: string;
    lastKnownGoodGeneration?: string;
    name?: string;
    retired: ExtensionRuntimeRetiredRecord[];
    selectedGeneration?: string;
    state: "active" | "disabled" | "failed" | "installed";
    version?: string;
}

interface ExtensionFailure {
    generation?: string;
    message: string;
}

export class ExtensionHost {
    readonly #active = new Map<string, ExtensionGeneration>();
    readonly #failures = new Map<string, ExtensionFailure>();
    readonly #loader: ExtensionGenerationLoader;
    readonly #registry: ExtensionRegistryPort;
    readonly #retired = new Map<string, Set<ExtensionGeneration>>();
    readonly #retirementPromises = new Set<Promise<void>>();
    #mutationTail: Promise<void> = Promise.resolve();
    #registrySnapshot?: ExtensionRegistrySnapshot;
    #started = false;
    #stopping = false;

    constructor(options: { loader: ExtensionGenerationLoader; registry: ExtensionRegistryPort }) {
        this.#loader = options.loader;
        this.#registry = options.registry;
    }

    async start(): Promise<void> {
        await this.#exclusive(async () => {
            if (this.#started) return;
            const snapshot = await this.#registry.read();
            this.#registrySnapshot = snapshot;
            for (const [id, entry] of Object.entries(snapshot.extensions).sort(([left], [right]) => left.localeCompare(right))) {
                if (!entry.enabled) continue;
                await this.#startEntry(id, entry).catch((error: unknown) => {
                    this.#recordFailure(id, entry.selectedGeneration, error);
                });
            }
            this.#started = true;
        });
    }

    acquire(id: string): ExtensionGenerationLease {
        if (this.#stopping) throw new Error("Extension host is stopping.");
        const active = this.#active.get(id);
        if (active === undefined) throw new Error(`Extension ${id} is not active.`);
        return active.acquire();
    }

    async dispatchRpc(
        id: string,
        operation: string,
        input: ExtensionJsonValue | undefined,
        context: { requestId: string; signal: AbortSignal }
    ): Promise<ExtensionJsonValue> {
        const lease = this.acquire(id);
        try {
            const handler = lease.activation.rpc?.[operation];
            if (handler === undefined) throw new Error(`Extension ${id} does not expose RPC operation ${operation}.`);
            return await handler(input, context);
        } finally {
            lease.release();
        }
    }

    async dispatchCommand(
        id: string,
        argv: readonly string[],
        context: { requestId: string; signal: AbortSignal }
    ): Promise<ExtensionCommandResult> {
        const lease = this.acquire(id);
        try {
            const handler = lease.activation.command;
            if (handler === undefined) throw new Error(`Extension ${id} does not expose a CLI command.`);
            return await handler(argv, context);
        } finally {
            lease.release();
        }
    }

    async activateGeneration(id: string, generation: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            const candidate = await this.#loadCandidate(id, generation);
            const snapshot = this.#requireRegistry();
            const next = cloneExtensionRegistry(snapshot);
            next.extensions[id] = {
                enabled: true,
                lastKnownGoodGeneration: generation,
                selectedGeneration: generation
            };
            try {
                await this.#registry.write(next);
            } catch (error) {
                await candidate.retire().catch(() => undefined);
                throw error;
            }
            this.#registrySnapshot = next;
            this.#swap(id, candidate);
            this.#failures.delete(id);
        });
    }

    async reload(id: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            const snapshot = this.#requireRegistry();
            const entry = snapshot.extensions[id];
            if (entry === undefined) throw new Error(`Extension ${id} is not installed.`);
            if (!entry.enabled) throw new Error(`Extension ${id} is disabled.`);
            const generation = entry.selectedGeneration;
            if (generation === undefined) throw new Error(`Extension ${id} has no selected generation.`);
            let candidate: ExtensionGeneration;
            try {
                candidate = await this.#loadCandidate(id, generation);
            } catch (error) {
                this.#recordFailure(id, generation, error);
                throw error;
            }
            const next = cloneExtensionRegistry(snapshot);
            next.extensions[id] = { ...entry, lastKnownGoodGeneration: generation };
            try {
                await this.#registry.write(next);
            } catch (error) {
                await candidate.retire().catch(() => undefined);
                throw error;
            }
            this.#registrySnapshot = next;
            this.#swap(id, candidate);
            this.#failures.delete(id);
        });
    }

    async enable(id: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            const snapshot = this.#requireRegistry();
            const entry = snapshot.extensions[id];
            if (entry === undefined) throw new Error(`Extension ${id} is not installed.`);
            if (!entry.enabled) {
                const next = cloneExtensionRegistry(snapshot);
                next.extensions[id] = { ...entry, enabled: true };
                await this.#registry.write(next);
                this.#registrySnapshot = next;
            }
            await this.#startEntry(id, this.#requireRegistry().extensions[id]!, true);
        });
    }

    async disable(id: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            const snapshot = this.#requireRegistry();
            const entry = snapshot.extensions[id];
            if (entry === undefined) throw new Error(`Extension ${id} is not installed.`);
            if (entry.enabled) {
                const next = cloneExtensionRegistry(snapshot);
                next.extensions[id] = { ...entry, enabled: false };
                await this.#registry.write(next);
                this.#registrySnapshot = next;
            }
            const active = this.#active.get(id);
            if (active !== undefined) {
                this.#active.delete(id);
                this.#trackRetired(id, active);
            }
            this.#failures.delete(id);
        });
    }

    async retireInstance(event: ExtensionInstanceRetireEvent): Promise<void> {
        const failures: unknown[] = [];
        await Promise.all([...this.#active.entries()].map(async ([id, generation]) => {
            const lease = generation.acquire();
            try {
                await lease.activation.lifecycle?.onInstanceRetire?.(event);
            } catch (error) {
                failures.push(new Error(`Extension ${id} failed to retire instance ${event.instance}.`, { cause: error }));
            } finally {
                lease.release();
            }
        }));
        if (failures.length > 0) {
            throw new AggregateError(failures, `Extensions failed to retire instance ${event.instance}.`);
        }
    }

    async list(): Promise<ExtensionRuntimeRecord[]> {
        const snapshot = this.#registrySnapshot ?? await this.#registry.read();
        if (this.#registrySnapshot === undefined) this.#registrySnapshot = snapshot;
        return Object.entries(snapshot.extensions)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, entry]) => this.#record(id, entry));
    }

    async stop(): Promise<void> {
        await this.#exclusive(async () => {
            if (this.#stopping) return;
            this.#stopping = true;
            for (const [id, generation] of this.#active) {
                this.#trackRetired(id, generation);
            }
            this.#active.clear();
        });
        const settled = await Promise.allSettled([...this.#retirementPromises]);
        const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) throw new AggregateError(failures, "Extension generations failed to dispose cleanly.");
    }

    async #startEntry(id: string, entry: ExtensionRegistryEntry, throwOnFailure = false): Promise<void> {
        const candidates = [...new Set([
            entry.selectedGeneration,
            entry.lastKnownGoodGeneration
        ].filter((value): value is string => value !== undefined))];
        if (candidates.length === 0) {
            const error = new Error(`Extension ${id} has no selected generation.`);
            this.#recordFailure(id, undefined, error);
            if (throwOnFailure) throw error;
            return;
        }
        let selectedFailure: unknown;
        for (const generation of candidates) {
            let candidate: ExtensionGeneration;
            try {
                candidate = await this.#loadCandidate(id, generation);
            } catch (error) {
                selectedFailure ??= error;
                this.#recordFailure(id, generation, error);
                continue;
            }
            const snapshot = this.#requireRegistry();
            const next = cloneExtensionRegistry(snapshot);
            next.extensions[id] = {
                ...entry,
                enabled: true,
                lastKnownGoodGeneration: generation,
                selectedGeneration: generation
            };
            try {
                await this.#registry.write(next);
            } catch (error) {
                await candidate.retire().catch(() => undefined);
                throw error;
            }
            this.#registrySnapshot = next;
            this.#swap(id, candidate);
            if (generation === entry.selectedGeneration) this.#failures.delete(id);
            return;
        }
        const failure = selectedFailure ?? new Error(`Extension ${id} could not load.`);
        if (throwOnFailure) throw failure;
    }

    async #loadCandidate(id: string, generation: string): Promise<ExtensionGeneration> {
        const candidate = await this.#loader.load(id, generation);
        if (candidate.manifest.id !== id) {
            await candidate.retire().catch(() => undefined);
            throw new Error(`Extension generation ${generation} declares id ${candidate.manifest.id}, expected ${id}.`);
        }
        return candidate;
    }

    #swap(id: string, candidate: ExtensionGeneration): void {
        candidate.activate();
        const previous = this.#active.get(id);
        this.#active.set(id, candidate);
        if (previous !== undefined) this.#trackRetired(id, previous);
    }

    #trackRetired(id: string, generation: ExtensionGeneration): void {
        const retired = this.#retired.get(id) ?? new Set<ExtensionGeneration>();
        retired.add(generation);
        this.#retired.set(id, retired);
        const retirement = generation.retire();
        this.#retirementPromises.add(retirement);
        void retirement.catch((error: unknown) => {
            this.#recordFailure(id, generation.generation, error);
        }).finally(() => {
            this.#retirementPromises.delete(retirement);
            retired.delete(generation);
            if (retired.size === 0) this.#retired.delete(id);
        });
    }

    #record(id: string, entry: ExtensionRegistryEntry): ExtensionRuntimeRecord {
        const active = this.#active.get(id);
        const failure = this.#failures.get(id);
        const retired = [...(this.#retired.get(id) ?? [])].map((generation) => ({
            generation: generation.generation,
            inFlight: generation.inFlight,
            state: generation.state
        }));
        return {
            ...(active === undefined ? {} : { activeGeneration: active.generation }),
            enabled: entry.enabled,
            ...(failure === undefined ? {} : { failure: { ...failure } }),
            id,
            ...(entry.lastKnownGoodGeneration === undefined ? {} : { lastKnownGoodGeneration: entry.lastKnownGoodGeneration }),
            ...(active === undefined ? {} : { name: active.manifest.name }),
            retired,
            ...(entry.selectedGeneration === undefined ? {} : { selectedGeneration: entry.selectedGeneration }),
            state: !entry.enabled
                ? "disabled"
                : active !== undefined
                    ? "active"
                    : failure !== undefined
                        ? "failed"
                        : "installed",
            ...(active === undefined ? {} : { version: active.manifest.version })
        };
    }

    #recordFailure(id: string, generation: string | undefined, error: unknown): void {
        this.#failures.set(id, {
            ...(generation === undefined ? {} : { generation }),
            message: error instanceof Error ? error.message : String(error)
        });
    }

    #requireRegistry(): ExtensionRegistrySnapshot {
        if (this.#registrySnapshot !== undefined) return this.#registrySnapshot;
        throw new Error("Extension host has not loaded its registry.");
    }

    #assertRunning(): void {
        if (!this.#started) throw new Error("Extension host has not started.");
        if (this.#stopping) throw new Error("Extension host is stopping.");
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.#mutationTail;
        let release!: () => void;
        this.#mutationTail = new Promise<void>((resolve) => {
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
