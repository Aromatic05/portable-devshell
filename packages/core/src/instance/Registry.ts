import type { Instance } from "./Instance.js";

export class InstanceRegistry {
    readonly #instances = new Map<string, Instance>();

    constructor(instances: readonly Instance[]) {
        for (const instance of instances) {
            this.#instances.set(instance.name, instance);
        }
    }

    get(name: string): Instance | undefined {
        return this.#instances.get(name);
    }

    add(instance: Instance): void {
        if (this.#instances.has(instance.name)) {
            throw new Error(
                `Cannot add active instance generation ${instance.name}; remove the current generation first.`,
            );
        }
        this.#instances.set(instance.name, instance);
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
