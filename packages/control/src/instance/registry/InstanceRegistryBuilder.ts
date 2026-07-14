import type { ControlConfig } from "../../control/config/codec/ConfigTomlCodec.js";
import { InstanceConfigMapper } from "../InstanceConfigMapper.js";
import { InstanceRegistry } from "./InstanceRegistry.js";

export class InstanceRegistryBuilder {
    readonly #mapper: InstanceConfigMapper;

    constructor(options?: { mapper?: InstanceConfigMapper }) {
        this.#mapper = options?.mapper ?? new InstanceConfigMapper();
    }

    build(config: ControlConfig): InstanceRegistry {
        return new InstanceRegistry(
            config.instances.filter((instance) => instance.enabled).map((instance) => this.#mapper.map(instance))
        );
    }
}
