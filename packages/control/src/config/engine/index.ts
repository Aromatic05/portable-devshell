import {
    ConfigInputError,
    createRemoteError,
    controlErrorCodes,
    formatConfigPath,
    toConfigView,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";

import { ControlConfigValidator } from "./Validator.js";
import {
    ControlConfigMutationLock,
    type ControlConfigMutationRunner,
} from "./Lock.js";
import { buildApplyResult, type ConfigApplyChange } from "./Result.js";
import {
    ConfigRegistry,
    createCoreConfigRegistry,
    type ConfigDomainDefinition,
} from "../domain/Registry.js";
import { ConfigChangeHub } from "../change/Config.js";
import { diffConfigPaths } from "../Path.js";
import type {
    ConfigEngineOptions,
    ConfigRuntimeChangeSet,
    ControlConfigWriter,
} from "./Api.js";

export class ConfigEngine {
    readonly #changeHub?: ConfigChangeHub;
    readonly #configStore: ControlConfigWriter;
    readonly #getConfig: () => ControlConfig;
    readonly #getRestartControlRequired: () => boolean;
    readonly #homeDirectory?: string;
    readonly #markRestartControlRequired: () => void;
    readonly #mutationRunner: ControlConfigMutationRunner;
    readonly #registry: ConfigRegistry;
    readonly #runtimeApply?: ConfigEngineOptions["runtimeApply"];
    readonly #runtimePreflight: NonNullable<
        ConfigEngineOptions["runtimePreflight"]
    >;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #validator: ControlConfigValidator;

    constructor(options: ConfigEngineOptions) {
        this.#changeHub = options.changeHub;
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getRestartControlRequired =
            options.getRestartControlRequired ?? (() => false);
        this.#homeDirectory = options.homeDirectory;
        this.#markRestartControlRequired =
            options.markRestartControlRequired ?? (() => undefined);
        this.#mutationRunner =
            options.mutationRunner ?? new ControlConfigMutationLock();
        this.#registry = options.registry ?? createCoreConfigRegistry();
        this.#runtimeApply = options.runtimeApply;
        this.#runtimePreflight =
            options.runtimePreflight ?? noopRuntimePreflight;
        this.#setConfig = options.setConfig;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    get current(): ControlConfig {
        return this.#getConfig();
    }

    get restartControlRequired(): boolean {
        return this.#getRestartControlRequired();
    }

    get domains(): readonly ConfigDomainDefinition[] {
        return this.#registry.list();
    }

    requireDomain(id: string): ConfigDomainDefinition {
        return this.#registry.require(id);
    }

    getConfigView(): JsonValue {
        return toConfigView(
            this.#getConfig(),
            this.#getRestartControlRequired(),
        ) as unknown as JsonValue;
    }

    validateConfig(config: ControlConfig): ControlConfig {
        return this.#validator.validate(config);
    }

    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        return await this.#mutationRunner.runExclusive(operation);
    }

    async preflight(
        previous: ControlConfig,
        next: ControlConfig,
    ): Promise<void> {
        await this.#runtimePreflight.assertAvailable(previous, next);
    }

    async persist(config: ControlConfig): Promise<void> {
        await this.#configStore.write(config, this.#homeDirectory);
        this.#setConfig(config);
    }

    async commit(
        previous: ControlConfig,
        next: ControlConfig,
        changes: readonly ConfigApplyChange[],
        runtimeChanges: ConfigRuntimeChangeSet,
        preflight = true,
    ): Promise<JsonValue> {
        const validated = this.validateConfig(next);
        if (preflight) await this.preflight(previous, validated);
        await this.persist(validated);
        const hotApplied = await this.applyRuntimeOrRestore(
            previous,
            validated,
            runtimeChanges,
        );
        return this.finalizeApplyResult(previous, validated, changes, hotApplied);
    }

    async applyRuntimeOrRestore(
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet,
    ): Promise<boolean> {
        if (this.#runtimeApply === undefined) return false;
        try {
            return await this.#runtimeApply.apply(previous, next, changes);
        } catch (error) {
            try {
                await this.persist(previous);
            } catch (restoreError) {
                throw new AggregateError(
                    [error, restoreError],
                    "Configuration runtime apply failed and configuration restore was incomplete.",
                );
            }
            throw error;
        }
    }

    async rollbackRuntime(
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet,
    ): Promise<void> {
        if (this.#runtimeApply === undefined) return;
        await this.#runtimeApply.apply(previous, next, changes);
    }

    finalizeApplyResult(
        previous: ControlConfig,
        next: ControlConfig,
        changes: readonly ConfigApplyChange[],
        hotApplied = false,
    ): JsonValue {
        const result = buildApplyResult(
            previous,
            next,
            [...changes],
            hotApplied,
        );
        if (result.restartControlRequired) this.#markRestartControlRequired();
        this.publishCommittedChange(previous, next);
        return result as unknown as JsonValue;
    }

    publishCommittedChange(
        previous: ControlConfig,
        next: ControlConfig,
    ): void {
        this.#changeHub?.publish([
            ...diffConfigPaths(previous.control, next.control, "control"),
            ...diffConfigPaths(previous.instances, next.instances, "instances"),
            ...diffConfigPaths(previous.mcp, next.mcp, "mcp"),
            ...diffConfigPaths(previous.web, next.web, "web"),
        ]);
    }

    readInput<T>(read: () => T): T {
        try {
            return read();
        } catch (error) {
            if (!(error instanceof ConfigInputError)) throw error;
            throw createRemoteError({
                code: controlErrorCodes.configInvalid,
                cause: error,
                details: {
                    fieldPath: formatConfigPath(error.issue.path),
                    issueCode: error.issue.code,
                    phase: error.issue.phase,
                },
                message: error.message,
                retryable: false,
            });
        }
    }
}

const noopRuntimePreflight = {
    async assertAvailable(): Promise<void> {},
};
