import { createError, errorCodes } from "@portable-devshell/shared";

import { ControlConfigStore } from "../../modules/config/config/ControlConfigStore.js";
import type { ControlConfig } from "../../modules/config/config/codec/ConfigTomlCodec.js";
import { InstanceRegistry } from "../../modules/instance/registry/InstanceRegistry.js";
import { InstanceRegistryFactory } from "../InstanceRegistryFactory.js";

export interface ControlStateOptions {
    configStore?: ControlConfigStore;
    homeDirectory?: string;
    instanceRegistryFactory?: InstanceRegistryFactory;
}

export class ControlState {
    readonly configStore: ControlConfigStore;
    readonly homeDirectory?: string;
    readonly #instanceRegistryFactory: InstanceRegistryFactory;
    #config?: ControlConfig;
    #instances = new InstanceRegistry([]);

    constructor(options: ControlStateOptions = {}) {
        this.configStore = options.configStore ?? new ControlConfigStore();
        this.homeDirectory = options.homeDirectory;
        this.#instanceRegistryFactory = options.instanceRegistryFactory ?? new InstanceRegistryFactory();
    }

    get config(): ControlConfig | undefined {
        return this.#config;
    }

    get instances(): InstanceRegistry {
        return this.#instances;
    }

    async load(): Promise<void> {
        const config = await this.configStore.readOrCreate(this.homeDirectory);
        this.#config = config;
        this.#instances = this.#instanceRegistryFactory.build(config);
    }

    requireConfig(): ControlConfig {
        if (this.#config !== undefined) return this.#config;
        throw createError({
            code: errorCodes.controlConfigLoadFailed,
            message: "Control config is not loaded.",
            retryable: false
        });
    }

    setConfig(config: ControlConfig): void {
        this.#config = config;
    }

    reset(): void {
        this.#config = undefined;
        this.#instances = new InstanceRegistry([]);
    }
}
