import type { ControlConfig } from "@portable-devshell/shared";
import { InstanceFactory } from "../create/Factory.js";
import { InstanceRegistry } from "./Registry.js";

export class InstanceRegistryFactory {
    readonly #mapper: InstanceFactory;

    constructor(options?: { mapper?: InstanceFactory }) {
        this.#mapper = options?.mapper ?? new InstanceFactory();
    }

    build(config: ControlConfig): InstanceRegistry {
        return new InstanceRegistry(
            config.instances.filter((instance) => instance.enabled).map((instance) => this.#mapper.map(instance))
        );
    }
}
