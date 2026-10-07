import type { Instance } from "@portable-devshell/core";

export class InstanceRegistry {
    readonly #instances = new Map<string, Instance>();

    constructor(instances: readonly Instance[]) {
        for (const instance of instances) {
            this.#instances.set(instance.config.name, instance);
        }
    }

    get(name: string): Instance | undefined {
        return this.#instances.get(name);
    }

    add(instance: Instance): void {
        if (this.#instances.has(instance.config.name)) {
            throw new Error(
                `Cannot add active instance generation ${instance.config.name}; remove the current generation first.`,
            );
        }
        this.#instances.set(instance.config.name, instance);
    }

    async remove(
        name: string,
        expected?: Instance,
    ): Promise<Instance | undefined> {
        const instance = this.#instances.get(name);
        if (instance === undefined) return undefined;
        if (expected !== undefined && instance !== expected) {
            throw new Error(`Cannot remove stale instance generation ${name}.`);
        }
        const retiring = instance.retire();
        this.#instances.delete(name);
        await retiring;
        return instance;
    }

    list(): readonly Instance[] {
        return [...this.#instances.values()];
    }
}
