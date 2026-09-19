import type { InstanceDescriptor } from "../Descriptor.js";

export interface InstanceGenerationLease {
    readonly descriptor: InstanceDescriptor;
    release(): void;
}

interface InstanceGenerationState {
    admitted: number;
    retired: boolean;
    waiters: Set<() => void>;
}

export class InstanceRegistry {
    readonly #descriptors = new Map<string, InstanceDescriptor>();
    readonly #generations = new WeakMap<
        InstanceDescriptor,
        InstanceGenerationState
    >();
    readonly #owned = new Set<string>();
    readonly #ownedConnectionWorkers = new Map<
        string,
        Set<InstanceDescriptor["worker"]>
    >();
    readonly #connectionReferences = new Map<
        string,
        Map<InstanceDescriptor["worker"], Set<string>>
    >();
    readonly #changeListeners = new Set<() => void>();

    constructor(descriptors: readonly InstanceDescriptor[]) {
        for (const descriptor of descriptors) {
            this.#descriptors.set(descriptor.name, descriptor);
            this.#generations.set(descriptor, createGenerationState());
        }
    }

    get(name: string): InstanceDescriptor | undefined {
        return this.#descriptors.get(name);
    }

    add(descriptor: InstanceDescriptor): void {
        if (this.#descriptors.has(descriptor.name)) {
            throw new Error(
                `Cannot add active instance generation ${descriptor.name}; retire the current generation first.`,
            );
        }
        this.#descriptors.set(descriptor.name, descriptor);
        this.#generations.set(descriptor, createGenerationState());
        this.#emitChange();
    }

    update(descriptor: InstanceDescriptor): void {
        const current = this.#descriptors.get(descriptor.name);
        if (current === undefined) {
            throw new Error(
                `Cannot update unregistered instance ${descriptor.name}.`,
            );
        }
        if (current !== descriptor) {
            throw new Error(
                `Cannot replace active instance generation ${descriptor.name} with update(); retire it first.`,
            );
        }
        this.#emitChange();
    }

    delete(name: string): void {
        const descriptor = this.#descriptors.get(name);
        if (descriptor !== undefined) {
            this.#retireAdmission(descriptor);
            this.#descriptors.delete(name);
            this.clearOwned(name);
            this.#emitChange();
        }
    }

    acquireGeneration(
        name: string,
        expected?: InstanceDescriptor,
    ): InstanceGenerationLease {
        const descriptor = this.#descriptors.get(name);
        if (descriptor === undefined || (expected !== undefined && descriptor !== expected)) {
            throw new Error(`Instance generation ${name} is not active.`);
        }
        const state = this.#requireGenerationState(descriptor);
        if (state.retired) {
            throw new Error(`Instance generation ${name} is retired.`);
        }
        state.admitted += 1;
        let released = false;
        return {
            descriptor,
            release: () => {
                if (released) return;
                released = true;
                state.admitted -= 1;
                if (state.admitted !== 0) return;
                for (const waiter of state.waiters) waiter();
                state.waiters.clear();
            },
        };
    }

    async retireGeneration(
        name: string,
        expected?: InstanceDescriptor,
    ): Promise<InstanceDescriptor | undefined> {
        const descriptor = this.#descriptors.get(name);
        if (descriptor === undefined) return undefined;
        if (expected !== undefined && descriptor !== expected) {
            throw new Error(
                `Cannot retire stale instance generation ${name}.`,
            );
        }
        const state = this.#requireGenerationState(descriptor);
        this.#retireAdmission(descriptor);
        this.#descriptors.delete(name);
        this.#owned.delete(name);
        this.#emitChange();
        if (state.admitted > 0)
            await new Promise<void>((resolve) => {
                if (state.admitted === 0) resolve();
                else state.waiters.add(resolve);
            });
        return descriptor;
    }

    list(): readonly InstanceDescriptor[] {
        return [...this.#descriptors.values()];
    }

    markOwned(name: string): void {
        this.#owned.add(name);
    }

    clearOwned(name: string): void {
        this.#owned.delete(name);
        this.#ownedConnectionWorkers.delete(name);
        this.#connectionReferences.delete(name);
    }

    retainConnectionReference(
        name: string,
        worker: InstanceDescriptor["worker"],
        reference: string,
        ownsLifecycle: boolean,
    ): void {
        const workers =
            this.#connectionReferences.get(name) ??
            new Map<InstanceDescriptor["worker"], Set<string>>();
        for (const [candidate, references] of workers) {
            if (candidate !== worker && references.has(reference)) {
                throw new Error(
                    `Connection reference ${reference} is already bound to another Worker generation for ${name}.`,
                );
            }
        }
        const references = workers.get(worker) ?? new Set<string>();
        references.add(reference);
        workers.set(worker, references);
        this.#connectionReferences.set(name, workers);
        if (ownsLifecycle) {
            const owned =
                this.#ownedConnectionWorkers.get(name) ??
                new Set<InstanceDescriptor["worker"]>();
            owned.add(worker);
            this.#ownedConnectionWorkers.set(name, owned);
        }
    }

    releaseConnectionReference(name: string, reference: string):
        | {
              shouldStop: boolean;
              worker: InstanceDescriptor["worker"];
          }
        | undefined {
        const workers = this.#connectionReferences.get(name);
        if (workers === undefined) return undefined;
        const matched = [...workers.entries()].filter(([, references]) =>
            references.has(reference),
        );
        if (matched.length === 0) return undefined;
        if (matched.length > 1)
            throw new Error(
                `Connection reference ${reference} is ambiguous for instance ${name}.`,
            );
        const [worker, references] = matched[0]!;
        references.delete(reference);
        if (references.size > 0) return { shouldStop: false, worker };
        workers.delete(worker);
        if (workers.size === 0) this.#connectionReferences.delete(name);
        return {
            shouldStop:
                this.#ownedConnectionWorkers.get(name)?.has(worker) === true &&
                !this.#owned.has(name),
            worker,
        };
    }

    clearConnectionOwnership(
        name: string,
        worker: InstanceDescriptor["worker"],
    ): void {
        const owned = this.#ownedConnectionWorkers.get(name);
        if (owned === undefined) return;
        owned.delete(worker);
        if (owned.size === 0) this.#ownedConnectionWorkers.delete(name);
    }

    onChange(listener: () => void): () => void {
        this.#changeListeners.add(listener);
        return () => {
            this.#changeListeners.delete(listener);
        };
    }

    async stopOwned(): Promise<void> {
        const failures: Error[] = [];
        const ownedWorkers = new Map<InstanceDescriptor["worker"], string>();
        for (const name of this.#owned) {
            const descriptor = this.#descriptors.get(name);
            if (descriptor === undefined) {
                this.clearOwned(name);
                continue;
            }
            ownedWorkers.set(descriptor.worker, name);
        }
        for (const [name, workers] of this.#ownedConnectionWorkers) {
            for (const worker of workers) ownedWorkers.set(worker, name);
        }
        for (const [worker, name] of ownedWorkers) {
            try {
                await worker.stop();
                this.#owned.delete(name);
                this.clearConnectionOwnership(name, worker);
            } catch (error) {
                failures.push(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        }

        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Failed to stop ${failures.length} worker instance(s).`,
            );
        }
    }

    #emitChange(): void {
        for (const listener of [...this.#changeListeners]) {
            listener();
        }
    }

    #requireGenerationState(
        descriptor: InstanceDescriptor,
    ): InstanceGenerationState {
        const state = this.#generations.get(descriptor);
        if (state !== undefined) return state;
        throw new Error(
            `Instance generation ${descriptor.name} is not registered.`,
        );
    }

    #retireAdmission(descriptor: InstanceDescriptor): void {
        this.#requireGenerationState(descriptor).retired = true;
    }
}

function createGenerationState(): InstanceGenerationState {
    return {
        admitted: 0,
        retired: false,
        waiters: new Set(),
    };
}
