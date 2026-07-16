import type { ControlConfig } from "../modules/config/config/codec/ConfigTomlCodec.js";
import { InstanceFactory } from "./InstanceFactory.js";
import { InstanceRegistry } from "../modules/instance/registry/InstanceRegistry.js";

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
