import type { InstanceDescriptor } from "../Descriptor.js";

export class InstanceRegistry {
    readonly #descriptors = new Map<string, InstanceDescriptor>();
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
        }
    }

    get(name: string): InstanceDescriptor | undefined {
        return this.#descriptors.get(name);
    }

    add(descriptor: InstanceDescriptor): void {
        this.#descriptors.set(descriptor.name, descriptor);
        this.#emitChange();
    }

    update(descriptor: InstanceDescriptor): void {
        if (!this.#descriptors.has(descriptor.name)) {
            throw new Error(
                `Cannot update unregistered instance ${descriptor.name}.`,
            );
        }
        this.#descriptors.set(descriptor.name, descriptor);
        this.#emitChange();
    }

    delete(name: string): void {
        if (this.#descriptors.delete(name)) {
            this.clearOwned(name);
            this.#emitChange();
        }
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
}
