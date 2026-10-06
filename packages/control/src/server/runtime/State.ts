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
import { InstanceRegistry } from "@portable-devshell/core/instance";
import { InstanceChangeHub } from "../../instance/Change.js";
import type { InstanceRuntimeRegistry } from "../../instance/Api.js";
import { createInstanceRuntimeRegistry } from "../../instance/index.js";
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
    readonly instanceRuntimes: InstanceRuntimeRegistry;
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
        this.instanceRuntimes = createInstanceRuntimeRegistry({
            homeDirectory: options.homeDirectory,
            toolCalls: this.toolCalls,
        });
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
        try {
            this.#instances = new InstanceRegistry(
                config.instances
                    .filter((instance) => instance.enabled)
                    .map((instance) => this.instanceRuntimes.create(instance)),
            );
        } catch (error) {
            this.reset();
            try {
                await this.instanceRuntimes.close();
            } catch (cleanupError) {
                throw new AggregateError([error, cleanupError], "Control instance state load failed and cleanup was incomplete.");
            }
            throw error;
        }
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
