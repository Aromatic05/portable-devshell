import type { InstanceDescriptor } from "../InstanceDescriptor.js";

export class InstanceRegistry {
    readonly #descriptors = new Map<string, InstanceDescriptor>();
    readonly #owned = new Set<string>();
    readonly #ownedConnectionReferences = new Set<string>();
    readonly #connectionReferences = new Map<string, Set<string>>();
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
        this.#ownedConnectionReferences.delete(name);
        this.#connectionReferences.delete(name);
    }

    retainConnectionReference(name: string, reference: string, ownsLifecycle: boolean): void {
        const references = this.#connectionReferences.get(name) ?? new Set<string>();
        references.add(reference);
        this.#connectionReferences.set(name, references);
        if (ownsLifecycle) {
            this.#ownedConnectionReferences.add(name);
        }
    }

    releaseConnectionReference(name: string, reference: string): boolean {
        const references = this.#connectionReferences.get(name);
        if (references === undefined) return false;
        references.delete(reference);
        if (references.size > 0) return false;
        this.#connectionReferences.delete(name);
        return this.#ownedConnectionReferences.has(name) && !this.#owned.has(name);
    }

    clearConnectionOwnership(name: string): void {
        this.#ownedConnectionReferences.delete(name);
    }

    onChange(listener: () => void): () => void {
        this.#changeListeners.add(listener);
        return () => {
            this.#changeListeners.delete(listener);
        };
    }

    async stopOwned(): Promise<void> {
        const failures: Error[] = [];

        const owned = new Set([...this.#owned, ...this.#ownedConnectionReferences]);
        for (const name of owned) {
            const descriptor = this.#descriptors.get(name);
            if (descriptor === undefined) {
                this.clearOwned(name);
                continue;
            }
            try {
                await descriptor.worker.stop();
                this.clearOwned(name);
            } catch (error) {
                failures.push(error instanceof Error ? error : new Error(String(error)));
            }
        }

        if (failures.length > 0) {
            throw new AggregateError(failures, `Failed to stop ${failures.length} worker instance(s).`);
        }
    }

    #emitChange(): void {
        for (const listener of [...this.#changeListeners]) {
            listener();
        }
    }
}
