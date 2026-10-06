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
import { createInstance, InstanceRegistry } from "@portable-devshell/core";
import { InstanceChangeHub } from "../../instance/Change.js";
import { createToolCallRegistry } from "../../toolcall/index.js";

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
    readonly toolCalls = createToolCallRegistry();
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
        const created = [];
        try {
            for (const instance of config.instances) {
                if (!instance.enabled) continue;
                created.push(createInstance(instance));
            }
            this.#instances = new InstanceRegistry(created);
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            for (const instance of created)
                await instance.close().catch((cleanupError) =>
                    cleanupFailures.push(cleanupError),
                );
            this.reset();
            if (cleanupFailures.length > 0)
                throw new AggregateError(
                    [error, ...cleanupFailures],
                    "Control instance state load failed and cleanup was incomplete.",
                );
            throw error;
        }
        this.#restartControlRequired = false;
    }


    async closeInstances(): Promise<void> {
        const failures: unknown[] = [];
        for (const instance of this.#instances.list())
            await instance.close().catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                "Control instance cleanup was incomplete.",
            );
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
