import type {
    ConfigUpdateInstanceRequest,
    ControlConfig,
    JsonValue,
} from "@portable-devshell/shared";

import type {
    ConfigBatchInstancePlan,
    ConfigBatchInstancePort,
} from "../../config/editor/Batch.js";
import {
    InstanceReconfigurationCoordinator,
    type PreparedInstanceDescriptor,
} from "./Update.js";
import { InstanceCleanupDebt } from "./retirement/Debt.js";
import { InstanceRetirementCoordinator } from "./retirement/index.js";
import type { InstanceEditorCoordinatorOptions } from "./Options.js";

export type { InstanceEditorCoordinatorOptions } from "./Options.js";

export class InstanceEditorCoordinator implements ConfigBatchInstancePort {
    readonly #cleanup: InstanceCleanupDebt;
    readonly #retirement: InstanceRetirementCoordinator;
    readonly #updates: InstanceReconfigurationCoordinator;

    constructor(options: InstanceEditorCoordinatorOptions) {
        this.#retirement = new InstanceRetirementCoordinator(options);
        this.#cleanup = new InstanceCleanupDebt(
            options,
            this.#retirement.hooks,
            (instance, descriptor) =>
                this.#retirement.prepareContextCleanup(instance, descriptor),
            (instance) => this.#updates.syncMcpEndpoint(instance),
        );
        this.#updates = new InstanceReconfigurationCoordinator(
            options,
            this.#retirement,
            this.#cleanup,
        );
    }

    async createPlan(
        request: ConfigUpdateInstanceRequest,
        currentConfig: ControlConfig,
    ): Promise<ConfigBatchInstancePlan> {
        const plan = await this.#updates.createUpdatePlan(request, currentConfig);
        let prepared: PreparedInstanceDescriptor | undefined;
        return {
            authChanged: plan.authChanged,
            instance: plan.instance,
            target: plan.target,
            apply: async () =>
                await this.#updates.applyPreparedInstance(plan, prepared),
            assertReady: () => this.#updates.assertUpdateReady(plan),
            cleanup: async () =>
                await this.#updates.cleanupPreparedUpdate(plan, prepared),
            prepare: () => {
                prepared = this.#updates.prepareUpdate(plan);
            },
            reserve: async () => await this.#updates.reservePreparedUpdate(plan),
            rollback: async () =>
                await this.#updates.rollbackPreparedInstance(plan, prepared),
        };
    }

    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#retirement.hooks.registerInstanceDeleteRetirement(retire);
    }

    registerInstanceDisableRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#retirement.hooks.registerInstanceDisableRetirement(retire);
    }

    registerInstanceGenerationRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#retirement.hooks.registerInstanceGenerationRetirement(retire);
    }

    async assertInstanceCleanupSettled(
        instance: string,
        reconcile = true,
    ): Promise<void> {
        await this.#cleanup.assertInstanceCleanupSettled(instance, reconcile);
    }

    async reconcileCleanupDebt(instance?: string): Promise<void> {
        await this.#cleanup.reconcileCleanupDebt(instance);
    }

    async listCleanupDebts(): Promise<Array<Record<string, string>>> {
        return await this.#cleanup.listCleanupDebts();
    }

    async updateInstanceConfig(params?: JsonValue): Promise<JsonValue> {
        return await this.#updates.updateInstanceConfig(params);
    }

    async deleteInstance(params?: JsonValue): Promise<JsonValue> {
        return await this.#retirement.deleteInstance(params, this.#cleanup);
    }

    async enableInstance(params?: JsonValue): Promise<JsonValue> {
        return await this.#updates.enableInstance(params);
    }

    async disableInstance(params?: JsonValue): Promise<JsonValue> {
        return await this.#updates.disableInstance(params);
    }
}
