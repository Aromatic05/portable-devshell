import type {
    ExtensionInvocationContext
} from "@portable-devshell/extension";
import type { CliCommandBinding, CliCommandResult } from "@portable-devshell/extension/cli";
import {
    createError,
    errorCodes,
    toControlErrorBody,
    type ExtensionRuntimeRecord
} from "@portable-devshell/shared";

import { ExtensionGeneration, type ExtensionGenerationLease } from "./generation/ExtensionGeneration.js";
import {
    cloneExtensionRegistry,
    type ExtensionRegistryEntry,
    type ExtensionRegistrySnapshot
} from "../state/ExtensionRegistryModel.js";
import type { ExtensionRegistryPort } from "../state/ExtensionRegistryStore.js";

export interface ExtensionGenerationLoader {
    load(id: string, generation: string): Promise<ExtensionGeneration>;
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
    readonly #retirementFailures = new Map<string, unknown[]>();
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
        if (this.#stopping) throw extensionFailure(id, undefined, new Error("Extension host is stopping."));
        const active = this.#active.get(id);
        if (active === undefined) {
            const entry = this.#registrySnapshot?.extensions[id];
            if (entry === undefined) throw extensionNotFound(id);
            throw extensionNotActive(id);
        }
        if (active.state === "faulted") {
            throw extensionFailure(
                id,
                active.generation,
                active.faultError ?? new Error(`Extension ${id} sandbox faulted.`)
            );
        }
        return active.acquire();
    }

    async dispatchCommand(
        commandId: string,
        argv: readonly string[],
        context: ExtensionInvocationContext
    ): Promise<CliCommandResult> {
        const { lease, registration } = this.acquireRegistration("cli.commands", commandId);
        try {
            if (typeof registration.binding !== "function") {
                throw extensionInvalid(commandId, "has an invalid cli.commands binding");
            }
            return await (registration.binding as CliCommandBinding)(argv, context);
        } finally {
            lease.release();
        }
    }

    acquireRegistration(pointId: string, id: string): {
        extensionId: string;
        lease: ExtensionGenerationLease;
        registration: NonNullable<ReturnType<ExtensionGenerationLease["registrations"]["get"]>>;
    } {
        if (this.#stopping) throw new Error("Extension host is stopping.");
        const matches = [...this.#active.entries()].flatMap(([extensionId, generation]) => {
            const registration = generation.registrations.get(pointId, id);
            return registration === undefined ? [] : [{ extensionId, generation, registration }];
        });
        if (matches.length === 0) {
            throw new Error(`No active Extension registration for ${pointId}/${id}.`);
        }
        if (matches.length > 1) {
            throw new Error(`Conflicting active Extension registrations for ${pointId}/${id}.`);
        }
        const match = matches[0]!;
        const lease = match.generation.acquire();
        const registration = lease.registrations.get(pointId, id);
        if (registration === undefined) {
            lease.release();
            throw new Error(`Extension registration disappeared during acquisition: ${pointId}/${id}.`);
        }
        return { extensionId: match.extensionId, lease, registration };
    }

    async activateGeneration(id: string, generation: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            let candidate: ExtensionGeneration;
            try {
                candidate = await this.#loadCandidate(id, generation);
            } catch (error) {
                throw extensionFailure(id, generation, error);
            }
            const snapshot = this.#requireRegistry();
            const next = cloneExtensionRegistry(snapshot);
            next.extensions[id] = {
                enabled: true,
                lastKnownGoodGeneration: generation,
                selectedGeneration: generation
            };
            try {
                await this.#commitCandidate(id, candidate, snapshot, next);
            } catch (error) {
                if (error instanceof ExtensionCandidatePublicationError) {
                    throw extensionFailure(id, generation, error.cause ?? error);
                }
                throw error;
            }
            this.#failures.delete(id);
        });
    }

    async reload(id: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            const snapshot = this.#requireRegistry();
            const entry = snapshot.extensions[id];
            if (entry === undefined) throw extensionNotFound(id);
            if (!entry.enabled) throw extensionNotActive(id, "disabled");
            const generation = entry.selectedGeneration;
            if (generation === undefined) throw extensionInvalid(id, "has no selected generation");
            let candidate: ExtensionGeneration;
            try {
                candidate = await this.#loadCandidate(id, generation);
            } catch (error) {
                this.#recordFailure(id, generation, error);
                throw extensionFailure(id, generation, error);
            }
            const next = cloneExtensionRegistry(snapshot);
            next.extensions[id] = { ...entry, lastKnownGoodGeneration: generation };
            try {
                await this.#commitCandidate(id, candidate, snapshot, next);
            } catch (error) {
                if (error instanceof ExtensionCandidatePublicationError) {
                    this.#recordFailure(id, generation, error.cause ?? error);
                    throw extensionFailure(id, generation, error.cause ?? error);
                }
                throw error;
            }
            this.#failures.delete(id);
        });
    }

    async enable(id: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            const snapshot = this.#requireRegistry();
            const entry = snapshot.extensions[id];
            if (entry === undefined) throw extensionNotFound(id);
            await this.#startEntry(id, { ...entry, enabled: true }, true);
        });
    }

    async disable(id: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            const snapshot = this.#requireRegistry();
            const entry = snapshot.extensions[id];
            if (entry === undefined) throw extensionNotFound(id);
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

    async waitForDrain(id: string): Promise<void> {
        const retired = [...(this.#retired.get(id) ?? [])];
        const settled = await Promise.allSettled(retired.map(async (generation) => await generation.retire()));
        const failures = uniqueFailures([
            ...(this.#retirementFailures.get(id) ?? []),
            ...settled.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        ]);
        this.#retirementFailures.delete(id);
        if (failures.length > 0) {
            throw new AggregateError(failures, `Extension ${id} failed to drain cleanly.`);
        }
    }

    async forget(id: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#assertRunning();
            const snapshot = this.#requireRegistry();
            if (snapshot.extensions[id] === undefined) throw extensionNotFound(id);
            if (
                this.#active.has(id)
                || (this.#retired.get(id)?.size ?? 0) > 0
                || (this.#retirementFailures.get(id)?.length ?? 0) > 0
            ) {
                throw extensionInvalid(id, "still has active or draining generations");
            }
            const next = cloneExtensionRegistry(snapshot);
            delete next.extensions[id];
            await this.#registry.write(next);
            this.#registrySnapshot = next;
            this.#failures.delete(id);
        });
    }

    async retireInstanceResources(instance: string): Promise<void> {
        const failures: unknown[] = [];
        await Promise.all([...this.#active.entries()].map(async ([id, generation]) => {
            try {
                await generation.retireInstanceResources(instance);
            } catch (error) {
                failures.push(new Error(`Extension ${id} failed to retire resources for instance ${instance}.`, { cause: error }));
            }
        }));
        if (failures.length > 0) {
            throw new AggregateError(failures, `Extensions failed to retire resources for instance ${instance}.`);
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
        const failures = uniqueFailures([
            ...settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
            ...[...this.#retirementFailures.values()].flat()
        ]);
        this.#retirementFailures.clear();
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
                await this.#commitCandidate(id, candidate, snapshot, next);
            } catch (error) {
                if (!(error instanceof ExtensionCandidatePublicationError)) throw error;
                selectedFailure ??= error;
                this.#recordFailure(id, generation, error);
                continue;
            }
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

    async #commitCandidate(
        id: string,
        candidate: ExtensionGeneration,
        previousRegistry: ExtensionRegistrySnapshot,
        nextRegistry: ExtensionRegistrySnapshot
    ): Promise<void> {
        try {
            this.#assertNoRegistrationConflicts(id, candidate);
            candidate.activate();
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await candidate.retire().catch((cleanupError) => cleanupFailures.push(cleanupError));
            const cause = cleanupFailures.length === 0
                ? error
                : new AggregateError(
                    [error, ...cleanupFailures],
                    `Extension ${id} candidate activation failed and cleanup was incomplete.`
                );
            throw new ExtensionCandidatePublicationError(candidate.generation, cause);
        }
        try {
            await this.#registry.write(nextRegistry);
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await candidate.retire().catch((cleanupError) => cleanupFailures.push(cleanupError));
            if (cleanupFailures.length === 0) throw error;
            throw new AggregateError(
                [error, ...cleanupFailures],
                `Extension ${id} registry commit failed and candidate cleanup was incomplete.`
            );
        }
        if (candidate.state !== "active") {
            const failure = candidate.faultError instanceof Error
                ? candidate.faultError
                : new Error(`Extension generation ${candidate.generation} faulted before publication.`);
            const rollbackFailures: unknown[] = [];
            await this.#registry.write(previousRegistry).catch((error) => rollbackFailures.push(error));
            await candidate.retire().catch((error) => rollbackFailures.push(error));
            if (rollbackFailures.length === 0) {
                throw new ExtensionCandidatePublicationError(candidate.generation, failure);
            }
            throw new AggregateError(
                [failure, ...rollbackFailures],
                `Extension ${id} candidate faulted before publication and rollback was incomplete.`
            );
        }
        this.#registrySnapshot = nextRegistry;
        this.#publish(id, candidate);
    }

    #assertNoRegistrationConflicts(id: string, candidate: ExtensionGeneration): void {
        for (const registration of candidate.registrations.list()) {
            for (const [otherId, active] of this.#active) {
                if (otherId === id) continue;
                if (active.registrations.get(registration.pointId, registration.id) === undefined) continue;
                throw new Error(
                    `Extension registration conflict for ${registration.pointId}/${registration.id}: ${id} and ${otherId}.`
                );
            }
        }
    }

    #publish(id: string, candidate: ExtensionGeneration): void {
        if (candidate.state !== "active") {
            throw new Error(`Extension generation ${candidate.generation} is not publishable from ${candidate.state}.`);
        }
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
            const failures = this.#retirementFailures.get(id) ?? [];
            failures.push(error);
            this.#retirementFailures.set(id, failures);
            this.#recordFailure(id, generation.generation, error);
        }).finally(() => {
            this.#retirementPromises.delete(retirement);
            retired.delete(generation);
            if (retired.size === 0) this.#retired.delete(id);
        });
    }

    #record(id: string, entry: ExtensionRegistryEntry): ExtensionRuntimeRecord {
        const active = this.#active.get(id);
        const activeFailure = active?.state === "faulted"
            ? {
                  generation: active.generation,
                  message: active.faultError instanceof Error
                      ? active.faultError.message
                      : String(active.faultError ?? "Extension sandbox faulted.")
              }
            : undefined;
        const failure = activeFailure ?? this.#failures.get(id);
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
                : active?.state === "faulted"
                    ? "failed"
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
        if (!this.#started) throw extensionFailure("host", undefined, new Error("Extension host has not started."));
        if (this.#stopping) throw extensionFailure("host", undefined, new Error("Extension host is stopping."));
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

class ExtensionCandidatePublicationError extends Error {
    constructor(generation: string, cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`Extension generation ${generation} failed before publication: ${detail}`, { cause });
        this.name = "ExtensionCandidatePublicationError";
    }
}

function uniqueFailures(failures: readonly unknown[]): unknown[] {
    const unique: unknown[] = [];
    const seen = new Set<unknown>();
    for (const failure of failures) {
        if (seen.has(failure)) continue;
        seen.add(failure);
        unique.push(failure);
    }
    return unique;
}

function extensionNotFound(id: string): Error {
    return createError({
        code: errorCodes.controlExtensionNotFound,
        details: { extensionId: id },
        message: `Extension ${id} is not installed.`,
        retryable: false
    });
}

function extensionNotActive(id: string, reason?: string): Error {
    return createError({
        code: errorCodes.controlExtensionNotActive,
        details: { extensionId: id, ...(reason === undefined ? {} : { reason }) },
        message: `Extension ${id} is not active${reason === undefined ? "." : `: ${reason}.`}`,
        retryable: false
    });
}

function extensionInvalid(id: string, reason: string): Error {
    return createError({
        code: errorCodes.controlExtensionInvalid,
        details: { extensionId: id, reason },
        message: `Extension ${id} ${reason}.`,
        retryable: false
    });
}

function extensionFailure(id: string, generation: string | undefined, error: unknown): Error {
    if (toControlErrorBody(error) !== undefined) return error as Error;
    return createError({
        code: errorCodes.controlExtensionFailed,
        cause: error,
        details: { extensionId: id, ...(generation === undefined ? {} : { generation }) },
        message: error instanceof Error ? error.message : String(error),
        retryable: false
    });
}
