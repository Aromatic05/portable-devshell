import type { Instance } from "@portable-devshell/core";

export class InstanceRegistry {
    readonly #instances = new Map<string, Instance>();
    readonly #adding = new Set<(instance: Instance) => () => void>();

    constructor(instances: readonly Instance[]) {
        for (const instance of instances) {
            this.#instances.set(instance.config.name, instance);
        }
    }

    get(name: string): Instance | undefined {
        return this.#instances.get(name);
    }

    /** Install contributions before an instance becomes visible to consumers. */
    onAdding(install: (instance: Instance) => () => void): () => void {
        this.#adding.add(install);
        return () => this.#adding.delete(install);
    }

    add(instance: Instance): void {
        if (this.#instances.has(instance.config.name)) {
            throw new Error(
                `Cannot add active instance generation ${instance.config.name}; remove the current generation first.`,
            );
        }
        const releases: Array<() => void> = [];
        try {
            for (const install of this.#adding) releases.push(install(instance));
        } catch (error) {
            const failures: unknown[] = [error];
            for (const release of releases.reverse()) {
                try {
                    release();
                } catch (rollbackError) {
                    failures.push(rollbackError);
                }
            }
            if (failures.length === 1) throw error;
            throw new AggregateError(failures, `Instance ${instance.config.name} registration rollback failed.`);
        }
        this.#instances.set(instance.config.name, instance);
    }

    async remove(
        name: string,
        expected?: Instance,
        onRemoved?: () => void,
    ): Promise<Instance | undefined> {
        const detached = this.detach(name, expected, onRemoved);
        if (detached === undefined) return undefined;
        await detached.retirement;
        return detached.instance;
    }

    /** Remove visibility synchronously; let the coordinator await drain after committing. */
    detach(
        name: string,
        expected?: Instance,
        onRemoved?: () => void,
    ): { instance: Instance; retirement: Promise<void> } | undefined {
        const instance = this.#instances.get(name);
        if (instance === undefined) return undefined;
        if (expected !== undefined && instance !== expected) {
            throw new Error(`Cannot remove stale instance generation ${name}.`);
        }
        const retirement = instance.retire();
        // If the caller fails before awaiting drain, this rejection is still
        // handled. The original promise remains available for error reporting.
        void retirement.catch(() => undefined);
        this.#instances.delete(name);
        onRemoved?.();
        return { instance, retirement };
    }

    list(): readonly Instance[] {
        return [...this.#instances.values()];
    }
}
