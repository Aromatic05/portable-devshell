import {
    createRemoteError,
    controlErrorCodes,
    type ControlConfig,
} from "@portable-devshell/shared";

import { ControlConfigStore } from "../../config/store/index.js";
import { ControlConfigMutationLock } from "../../config/engine/Lock.js";
import {
    ConfigRegistry,
    createCoreConfigRegistry,
} from "../../config/domain/Registry.js";
import { ConfigChangeHub } from "../../config/change/Config.js";
import { InstanceRegistry, createInstance } from "@portable-devshell/core";
import { InstanceChangeHub } from "../../instance/Change.js";

export interface ControlRuntimeStateOptions {
    configRegistry?: ConfigRegistry;
    configStore?: ControlConfigStore;
    homeDirectory?: string;
}

export class ControlRuntimeState {
    readonly configChanges = new ConfigChangeHub();
    readonly configRegistry: ConfigRegistry;
    readonly configStore: ControlConfigStore;
    readonly configMutations = new ControlConfigMutationLock();
    readonly homeDirectory?: string;
    readonly instanceChanges = new InstanceChangeHub();
    #config?: ControlConfig;
    #instances = new InstanceRegistry([]);
    #restartControlRequired = false;

    constructor(options: ControlRuntimeStateOptions = {}) {
        this.configRegistry =
            options.configRegistry ?? createCoreConfigRegistry();
        this.configStore =
            options.configStore ??
            new ControlConfigStore({ registry: this.configRegistry });
        this.homeDirectory = options.homeDirectory;
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
        this.#instances = new InstanceRegistry(
            config.instances
                .filter((instance) => instance.enabled)
                .map((instance) => createInstance(instance)),
        );
        this.#restartControlRequired = false;
    }

    requireConfig(): ControlConfig {
        if (this.#config !== undefined) return this.#config;
        throw createRemoteError({
            code: controlErrorCodes.configLoadFailed,
            message: "Control config is not loaded.",
            retryable: false,
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
