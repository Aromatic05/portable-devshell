import type { ControlConfig } from "@portable-devshell/shared";
import type { ConfigChangeHub } from "../change/Config.js";
import type { ConfigRegistry } from "../domain/Registry.js";
import type { ControlConfigMutationRunner } from "./Lock.js";
import type { ControlConfigValidator } from "./Validator.js";

export interface ConfigRuntimeChangeSet {
    instanceAuth: boolean;
    mcp: boolean;
    web: boolean;
}

export interface ControlConfigWriter {
    write(config: ControlConfig, homeDirectory?: string): Promise<void>;
}

export interface ConfigEngineOptions {
    changeHub?: ConfigChangeHub;
    configStore: ControlConfigWriter;
    getConfig: () => ControlConfig;
    getRestartControlRequired?: () => boolean;
    homeDirectory?: string;
    markRestartControlRequired?: () => void;
    mutationRunner?: ControlConfigMutationRunner;
    registry?: ConfigRegistry;
    runtimeApply?: {
        apply(
            previous: ControlConfig,
            next: ControlConfig,
            changes: ConfigRuntimeChangeSet,
        ): Promise<boolean>;
    };
    runtimePreflight?: {
        assertAvailable(
            previous: ControlConfig,
            next: ControlConfig,
        ): Promise<void>;
    };
    setConfig: (config: ControlConfig) => void;
    validator?: ControlConfigValidator;
}
