import { createError, errorCodes, type ControlConfig } from "@portable-devshell/shared";

import { ControlConfigStore } from "../../control/config/ControlConfigStore.js";
import { ControlConfigMutationLock } from "../../control/config/ControlConfigMutationLock.js";
import { InstanceRegistry } from "../../control/instance/registry/InstanceRegistry.js";
import { InstanceRegistryFactory } from "../../control/instance/registry/InstanceRegistryFactory.js";

export interface ControlRuntimeStateOptions {
    configStore?: ControlConfigStore;
    homeDirectory?: string;
    instanceRegistryFactory?: InstanceRegistryFactory;
}

export class ControlRuntimeState {
    readonly configStore: ControlConfigStore;
    readonly configMutations = new ControlConfigMutationLock();
    readonly homeDirectory?: string;
    readonly #instanceRegistryFactory: InstanceRegistryFactory;
    #config?: ControlConfig;
    #instances = new InstanceRegistry([]);
    #restartControlRequired = false;

    constructor(options: ControlRuntimeStateOptions = {}) {
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

    get restartControlRequired(): boolean {
        return this.#restartControlRequired;
    }

    async load(): Promise<void> {
        const config = await this.configStore.readOrCreate(this.homeDirectory);
        this.#config = config;
        this.#instances = this.#instanceRegistryFactory.build(config);
        this.#restartControlRequired = false;
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

    markRestartControlRequired(): void {
        this.#restartControlRequired = true;
    }

    reset(): void {
        this.#config = undefined;
        this.#instances = new InstanceRegistry([]);
        this.#restartControlRequired = false;
    }
}
