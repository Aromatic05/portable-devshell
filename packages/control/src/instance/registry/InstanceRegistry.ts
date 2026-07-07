import type { InstanceDescriptor } from "../InstanceDescriptor.js";

export class InstanceRegistry {
    readonly #descriptors = new Map<string, InstanceDescriptor>();

    constructor(descriptors: readonly InstanceDescriptor[]) {
        for (const descriptor of descriptors) {
            this.#descriptors.set(descriptor.name, descriptor);
        }
    }

    get(name: string): InstanceDescriptor | undefined {
        return this.#descriptors.get(name);
    }

    list(): readonly InstanceDescriptor[] {
        return [...this.#descriptors.values()];
    }
}
