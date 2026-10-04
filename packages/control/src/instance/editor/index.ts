import type {
    ConfigUpdateInstanceRequest,
    ControlConfig,
    JsonValue,
} from "@portable-devshell/shared";

import type {
    ConfigBatchInstancePlan,
    ConfigBatchInstancePort,
} from "../../config/editor/Batch.js";
import type { ConfigRuntimeChangeSet } from "../../config/engine/index.js";
import { InstanceReconfigurationCoordinator } from "./Update.js";
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
            this.#retirement,
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
        return {
            authChanged: plan.authChanged,
            instance: plan.instance,
            target: plan.target,
            assertReady: () => this.#updates.assertUpdateReady(plan),
            commit: async (
                previous: ControlConfig,
                next: ControlConfig,
                runtimeChanges: ConfigRuntimeChangeSet,
            ) => {
                const prepared = this.#updates.prepareUpdate(plan);
                await this.#updates.persistPreparedConfig(next, plan, prepared);
                const hotApplied = await this.#updates.applyPreparedUpdate(
                    plan,
                    previous,
                    next,
                    prepared,
                    runtimeChanges,
                );
                await this.#updates.cleanupPreparedUpdate(plan, prepared);
                return hotApplied;
            },
        };
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
        listener: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#retirement.notification.registerInstanceDisabled(listener);
    }

    registerInstanceDeleted(
        listener: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        return this.#retirement.notification.registerInstanceDeleted(listener);
    }

    async assertInstanceCleanupSettled(instance: string): Promise<void> {
        await this.#cleanup.assertInstanceCleanupSettled(instance);
    }

    async reconcileCleanupDebt(instance?: string): Promise<void> {
        await this.#cleanup.reconcileCleanupDebt(instance);
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
