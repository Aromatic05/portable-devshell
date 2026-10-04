import { InstanceFactory, type InstanceDescriptor, type InstanceRegistry } from "@portable-devshell/core";
import type { ControlConfig, JsonValue } from "@portable-devshell/shared";
import { HttpEndpointPreflight } from "../../server/endpoint/Http.js";
import { ConfigEngine, type ConfigEngineOptions } from "../engine/index.js";
import { ConfigDraftValidator } from "./Draft.js";
import { ConfigGlobalPatch } from "./GlobalPatch.js";
import { ConfigBatchEditor } from "./Batch.js";
import { InstanceReconfigurationCoordinator } from "./instance/Update.js";
import { InstanceRetirementCoordinator } from "./instance/retirement/index.js";
import { InstanceCleanupDebt } from "./instance/retirement/Debt.js";
import type { ConfigMcpRuntimePort } from "./Mcp.js";

export type { ConfigRuntimeChangeSet } from "../engine/index.js";

export interface ConfigEditorCoordinatorOptions extends ConfigEngineOptions {
    cleanupDebtFile?: string;
    detachContextInstance?: (instance: string) => Promise<void>;
    reconcileContextInstanceCleanup?: (
        instance: string,
        descriptor?: InstanceDescriptor,
    ) => Promise<void>;
    instanceConfigMapper?: InstanceFactory;
    instanceRegistry: InstanceRegistry;
    mcp?: ConfigMcpRuntimePort;
}

export class ConfigEditorCoordinator {
    readonly #engine: ConfigEngine;
    readonly #drafts: ConfigDraftValidator;
    readonly #global: ConfigGlobalPatch;
    readonly #batch: ConfigBatchEditor;
    readonly #updates: InstanceReconfigurationCoordinator;
    readonly #retirement: InstanceRetirementCoordinator;
    readonly #debt: InstanceCleanupDebt;

    constructor(options: ConfigEditorCoordinatorOptions) {
        this.#engine = new ConfigEngine({
            ...options,
            runtimePreflight: options.runtimePreflight ?? new HttpEndpointPreflight(),
        });
        const lifecycleOptions = {
            ...options,
            engine: this.#engine,
            instanceConfigMapper: options.instanceConfigMapper ?? new InstanceFactory(),
        };
        this.#retirement = new InstanceRetirementCoordinator(lifecycleOptions);
        this.#debt = new InstanceCleanupDebt(
            lifecycleOptions,
            this.#retirement,
            (instance) => this.#updates.syncMcpEndpoint(instance),
        );
        this.#updates = new InstanceReconfigurationCoordinator(lifecycleOptions, this.#retirement, this.#debt);
        this.#global = new ConfigGlobalPatch(this.#engine);
        this.#batch = new ConfigBatchEditor(this.#engine, this.#updates);
        this.#drafts = new ConfigDraftValidator(this.#engine, options.getRestartControlRequired ?? (() => false));
    }

    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#retirement.notification.registerInstanceDeleteRetirement(retire);
    }

    registerInstanceDisableRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#retirement.notification.registerInstanceDisableRetirement(retire);
    }

    registerInstanceGenerationRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#retirement.notification.registerInstanceGenerationRetirement(retire);
    }

    registerInstanceDisabled(
        listener: (
            instance: ControlConfig["instances"][number],
        ) => Promise<void>,
    ): () => void {
        return this.#retirement.notification.registerInstanceDisabled(listener);
    }

    registerInstanceDeleted(
        listener: (
            instance: ControlConfig["instances"][number],
        ) => Promise<void>,
    ): () => void {
        return this.#retirement.notification.registerInstanceDeleted(listener);
    }

    async assertInstanceCleanupSettled(instance: string): Promise<void> {
        await this.#debt.assertInstanceCleanupSettled(instance);
    }

    async reconcileCleanupDebt(instance?: string): Promise<void> {
        await this.#debt.reconcileCleanupDebt(instance);
    }

    getConfigView(): JsonValue {
        return this.#engine.getConfigView();
    }

    validateConfigDraft(params: JsonValue | undefined): JsonValue {
        return this.#drafts.validate(params);
    }

    async updateInstanceConfig(
        params: JsonValue | undefined,
    ): Promise<JsonValue> {
        return await this.#updates.updateInstanceConfig(params);
    }

    async deleteInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#retirement.deleteInstance(params, this.#debt);
    }

    async enableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#updates.enableInstance(params);
    }

    async disableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#updates.disableInstance(params);
    }

    async updateCorePaths(patch: Readonly<Record<string, JsonValue>>): Promise<void> {
        await this.#global.updateCorePaths(patch);
    }

    async updateConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#batch.updateConfig(params);
    }

    async updateMcpConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#global.updateMcpConfig(params);
    }

    async updateWebConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#global.updateWebConfig(params);
    }
}
