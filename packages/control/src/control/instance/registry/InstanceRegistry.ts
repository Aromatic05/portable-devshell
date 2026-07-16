import type { InstanceDescriptor } from "../InstanceDescriptor.js";

export class InstanceRegistry {
    readonly #descriptors = new Map<string, InstanceDescriptor>();
    readonly #owned = new Set<string>();
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
    }

    onChange(listener: () => void): () => void {
        this.#changeListeners.add(listener);
        return () => {
            this.#changeListeners.delete(listener);
        };
    }

    async stopOwned(): Promise<void> {
        const failures: Error[] = [];

        for (const name of [...this.#owned]) {
            const descriptor = this.#descriptors.get(name);
            if (descriptor === undefined) {
                this.#owned.delete(name);
                continue;
            }
            try {
                await descriptor.worker.stop();
                this.#owned.delete(name);
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
