import {
    applyConfigInstancePatch,
    createRemoteError,
    controlErrorCodes,
    normalizeConfigInstanceDraft,
    parseConfigInstanceTargetRequest,
    parseConfigUpdateInstanceRequest,
    type ConfigUpdateInstanceRequest,
    type ControlConfig,
    type JsonValue,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import type { Instance, InstanceRegistry } from "@portable-devshell/core";
import { InstanceChangeHub } from "../Change.js";
import type { InstanceMcpRuntimePort } from "../Mcp.js";
import {
    type ConfigEngine,
} from "../../config/engine/index.js";
import type { ConfigRuntimeChangeSet } from "../../config/engine/Api.js";
import {
    requiresWorkerRebuild,
    toWorkerReconfigureInput,
} from "../../config/engine/Result.js";

import type { InstanceEditorCoordinatorOptions } from "./Options.js";
import type { InstanceRetirementCoordinator } from "./retirement/index.js";
import type { InstanceCleanupDebt } from "./retirement/Debt.js";
import { closeDescriptorResourcesBestEffort } from "./retirement/State.js";

type InstanceConfig = ControlConfig["instances"][number];
type InstanceDescriptor = Instance | undefined;
export type PreparedInstanceDescriptor = Instance;

export interface InstanceConfigUpdatePlan {
    readonly authChanged: boolean;
    readonly descriptor: InstanceDescriptor;
    readonly existing: InstanceConfig;
    readonly instance: InstanceConfig;
    readonly rebuildRequired: boolean;
    readonly target: string;
}

export class InstanceReconfigurationCoordinator {
    readonly #createRuntimeInstance: InstanceEditorCoordinatorOptions["createRuntimeInstance"];
    readonly #engine: ConfigEngine;
    readonly #instanceChanges: InstanceChangeHub;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcp?: InstanceMcpRuntimePort;
    readonly #retirement: InstanceRetirementCoordinator;
    readonly #cleanup: InstanceCleanupDebt;
    readonly #retireRuntimeInstance: InstanceEditorCoordinatorOptions["retireRuntimeInstance"];
    readonly #finalizeRuntimeInstance: InstanceEditorCoordinatorOptions["finalizeRuntimeInstance"];

    constructor(
        options: InstanceEditorCoordinatorOptions,
        retirement: InstanceRetirementCoordinator,
        cleanup: InstanceCleanupDebt,
    ) {
        this.#createRuntimeInstance = options.createRuntimeInstance;
        this.#engine = options.engine;
        this.#instanceChanges = options.instanceChanges;
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcp = options.mcp;
        this.#retirement = retirement;
        this.#cleanup = cleanup;
        this.#retireRuntimeInstance = options.retireRuntimeInstance;
        this.#finalizeRuntimeInstance = options.finalizeRuntimeInstance;
    }

    async createUpdatePlan(
        request: ConfigUpdateInstanceRequest,
        currentConfig: ControlConfig,
    ): Promise<InstanceConfigUpdatePlan> {
        const existing = currentConfig.instances.find(
            (entry) => entry.name === request.instanceName,
        );
        if (existing === undefined) throw missingInstance(request.instanceName);
        const instance = this.#engine.readInput(() =>
            normalizeConfigInstanceDraft(
                applyConfigInstancePatch(existing, request.patch),
            ),
        );
        if (!existing.enabled && instance.enabled) {
            await this.#cleanup.assertInstanceCleanupSettled(existing.name);
        }
        const descriptor = this.#instanceRegistry.get(request.instanceName);
        const rebuildRequired =
            descriptor !== undefined &&
            instance.enabled &&
            requiresWorkerRebuild(existing, instance);
        return {
            authChanged:
                JSON.stringify(existing.mcp.auth) !==
                JSON.stringify(instance.mcp.auth),
            descriptor,
            existing,
            instance,
            rebuildRequired,
            target: request.instanceName,
        };
    }

    assertUpdateReady(plan: InstanceConfigUpdatePlan): void {
        if (!plan.rebuildRequired || plan.descriptor === undefined) return;
        const snapshot = plan.descriptor.worker.snapshot();
        if (snapshot.daemonState === "stopped") return;
        throw createRemoteError({
            code: runtimeErrorCodes.instanceConflict,
            details: {
                instance: plan.target,
                operation: "update",
                status: snapshot.status,
            },
            message: `Instance ${plan.target} must be stopped before rebuilding its worker configuration.`,
            retryable: false,
        });
    }

    prepareUpdate(
        plan: InstanceConfigUpdatePlan,
    ): PreparedInstanceDescriptor | undefined {
        return this.#prepareInstanceDescriptor(
            plan.instance,
            plan.descriptor,
            plan.rebuildRequired,
        );
    }

    async persistPreparedConfig(
        nextConfig: ControlConfig,
        plan: InstanceConfigUpdatePlan | undefined,
        preparedDescriptor: PreparedInstanceDescriptor | undefined,
    ): Promise<void> {
        await this.#persistInstanceConfig(
            nextConfig,
            preparedDescriptor,
            plan?.descriptor,
        );
    }

    async applyPreparedUpdate(
        plan: InstanceConfigUpdatePlan,
        currentConfig: ControlConfig,
        nextConfig: ControlConfig,
        preparedDescriptor: PreparedInstanceDescriptor | undefined,
        runtimeChanges: ConfigRuntimeChangeSet,
    ): Promise<boolean> {
        return await this.#applyPersistedChanges({
            currentConfig,
            descriptor: plan.descriptor,
            existing: plan.existing,
            instance: plan.instance,
            nextConfig,
            preparedDescriptor,
            rebuildRequired: plan.rebuildRequired,
            runtimeChanges,
        });
    }

    async cleanupPreparedUpdate(
        plan: InstanceConfigUpdatePlan,
        preparedDescriptor: PreparedInstanceDescriptor | undefined,
    ): Promise<void> {
        await this.#cleanupCommittedInstanceChangeWithDebt(
            plan.existing,
            plan.instance,
            plan.descriptor,
            preparedDescriptor,
            plan.rebuildRequired,
        );
    }

    async updateInstanceConfig(
        params: JsonValue | undefined,
    ): Promise<JsonValue> {
        return await this.#engine.runExclusive(
            async () => await this.#updateInstanceConfig(params),
        );
    }

    async #updateInstanceConfig(
        params: JsonValue | undefined,
    ): Promise<JsonValue> {
        const request = this.#engine.readInput(() =>
            parseConfigUpdateInstanceRequest(params),
        );
        const currentConfig = this.#engine.current;
        const plan = await this.createUpdatePlan(request, currentConfig);
        const nextConfig = this.#engine.validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.map((entry) =>
                entry.name === request.instanceName ? plan.instance : entry,
            ),
        });
        const preparedDescriptor = this.prepareUpdate(plan);
        this.assertUpdateReady(plan);
        await this.persistPreparedConfig(nextConfig, plan, preparedDescriptor);
        const hotApplied = await this.applyPreparedUpdate(
            plan,
            currentConfig,
            nextConfig,
            preparedDescriptor,
            {
                instanceAuth: plan.authChanged,
                mcp: false,
                web: false,
            },
        );
        await this.cleanupPreparedUpdate(plan, preparedDescriptor);
        return this.#engine.finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "instance.updated", target: request.instanceName }],
            hotApplied,
        );
    }

    async enableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#engine.runExclusive(async () => {
            const { instanceName } = this.#engine.readInput(() =>
                parseConfigInstanceTargetRequest(params),
            );
            return await this.#setInstanceEnabled(instanceName, true);
        });
    }

    async disableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#engine.runExclusive(async () => {
            const { instanceName } = this.#engine.readInput(() =>
                parseConfigInstanceTargetRequest(params),
            );
            return await this.#setInstanceEnabled(instanceName, false);
        });
    }

    async #setInstanceEnabled(
        instanceName: string,
        enabled: boolean,
    ): Promise<JsonValue> {
        const currentConfig = this.#engine.current;
        const existing = currentConfig.instances.find(
            (entry) => entry.name === instanceName,
        );
        if (existing === undefined) throw missingInstance(instanceName);
        if (enabled && !existing.enabled) {
            await this.#cleanup.assertInstanceCleanupSettled(instanceName);
        }

        const instance = normalizeConfigInstanceDraft(
            applyConfigInstancePatch(existing, { enabled }),
        );
        const nextConfig = this.#engine.validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.map((entry) =>
                entry.name === instanceName ? instance : entry,
            ),
        });
        const descriptor = this.#instanceRegistry.get(instanceName);
        const preparedDescriptor = this.#prepareInstanceDescriptor(
            instance,
            descriptor,
            false,
        );
        await this.#persistInstanceConfig(
            nextConfig,
            preparedDescriptor,
            descriptor,
        );
        await this.#applyPersistedChanges({
            currentConfig,
            descriptor,
            existing,
            instance,
            nextConfig,
            preparedDescriptor,
            rebuildRequired: false,
            runtimeChanges: { instanceAuth: false, mcp: false, web: false },
        });
        await this.#cleanupCommittedInstanceChangeWithDebt(
            existing,
            instance,
            descriptor,
            preparedDescriptor,
            false,
        );
        return this.#engine.finalizeApplyResult(currentConfig, nextConfig, [
            {
                kind: enabled ? "instance.enabled" : "instance.disabled",
                target: instanceName,
            },
        ]);
    }

    async #applyPersistedChanges(input: {
        currentConfig: ControlConfig;
        descriptor: InstanceDescriptor;
        existing?: ControlConfig["instances"][number];
        instance?: ControlConfig["instances"][number];
        nextConfig: ControlConfig;
        preparedDescriptor?: Instance;
        rebuildRequired: boolean;
        runtimeChanges: ConfigRuntimeChangeSet;
    }): Promise<boolean> {
        let hotApplied = false;
        try {
            const runtimeChanged =
                input.runtimeChanges.instanceAuth ||
                input.runtimeChanges.mcp ||
                input.runtimeChanges.web;
            hotApplied = runtimeChanged
                ? await this.#engine.applyRuntimeOrRestore(
                      input.currentConfig,
                      input.nextConfig,
                      input.runtimeChanges,
                  )
                : false;
            if (input.existing !== undefined && input.instance !== undefined) {
                await this.#applyInstanceConfig(
                    input.existing,
                    input.instance,
                    input.descriptor,
                    input.rebuildRequired,
                    input.preparedDescriptor,
                );
                await this.syncMcpEndpoint(input.instance.name);
            }
            return hotApplied;
        } catch (error) {
            const failures: unknown[] = [error];
            if (hotApplied) {
                await this.#engine
                    .rollbackRuntime(
                        input.nextConfig,
                        input.currentConfig,
                        input.runtimeChanges,
                    )
                    .catch((rollbackError) => failures.push(rollbackError));
            }
            if (this.#engine.current !== input.currentConfig) {
                await this.#engine
                    .persist(input.currentConfig)
                    .catch((rollbackError) => failures.push(rollbackError));
            }
            if (input.existing !== undefined && input.instance !== undefined) {
                await this.#restoreInstanceRuntime(
                    input.existing,
                    input.descriptor,
                    input.preparedDescriptor,
                ).catch((rollbackError) => failures.push(rollbackError));
                try {
                    await this.syncMcpEndpoint(input.existing.name);
                } catch (rollbackError) {
                    failures.push(rollbackError);
                }
            } else if (input.preparedDescriptor !== undefined) {
                await closeDescriptorResourcesBestEffort(
                    input.preparedDescriptor,
                    this.#finalizeRuntimeInstance,
                ).catch((rollbackError) => failures.push(rollbackError));
            }
            if (failures.length === 1) throw error;
            throw new AggregateError(
                failures,
                "Configuration update failed and runtime rollback was incomplete.",
            );
        }
    }

    async #restoreInstanceRuntime(
        existing: ControlConfig["instances"][number],
        descriptor: InstanceDescriptor,
        preparedDescriptor: Instance | undefined,
    ): Promise<void> {
        const failures: unknown[] = [];
        let restored: Instance | undefined;
        if (descriptor === undefined || descriptor.retired) {
            const current = this.#instanceRegistry.get(existing.name);
            if (current !== undefined)
                await this.#instanceRegistry
                    .remove(existing.name, current, async (retiring) =>
                        await this.#retireRuntimeInstance(retiring),
                    )
                    .catch((error) => failures.push(error));
            if (existing.enabled) {
                try {
                    restored = this.#createRuntimeInstance(existing);
                    this.#instanceRegistry.add(restored);
                } catch (error) {
                    failures.push(error);
                }
            }
        } else {
            try {
                const current = this.#instanceRegistry.get(existing.name);
                if (current !== undefined && current !== descriptor) {
                    await this.#instanceRegistry.remove(
                        existing.name,
                        current,
                        async (retiring) =>
                            await this.#retireRuntimeInstance(retiring),
                    );
                }
                descriptor.update(existing);
                await descriptor.worker.reconfigure(
                    toWorkerReconfigureInput(existing),
                );
                if (this.#instanceRegistry.get(existing.name) !== descriptor)
                    this.#instanceRegistry.add(descriptor);
                restored = descriptor;
            } catch (error) {
                failures.push(error);
            }
        }
        this.#instanceChanges.publish("registry");
        if (
            preparedDescriptor !== undefined &&
            preparedDescriptor !== restored
        ) {
            await closeDescriptorResourcesBestEffort(
                preparedDescriptor,
                this.#finalizeRuntimeInstance,
            ).catch(
                (error) => failures.push(error),
            );
        }
        if (descriptor?.retired && descriptor !== restored) {
            await closeDescriptorResourcesBestEffort(
                descriptor,
                this.#finalizeRuntimeInstance,
            ).catch((error) => failures.push(error));
        }
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Failed to restore instance ${existing.name}.`,
            );
    }

    #prepareInstanceDescriptor(
        instance: ControlConfig["instances"][number],
        descriptor: InstanceDescriptor,
        rebuildRequired: boolean,
    ): Instance | undefined {
        if (!instance.enabled) return undefined;
        if (descriptor === undefined || rebuildRequired)
            return this.#createRuntimeInstance(instance);
        return undefined;
    }

    async #applyInstanceConfig(
        existing: ControlConfig["instances"][number],
        instance: ControlConfig["instances"][number],
        descriptor: InstanceDescriptor,
        rebuildRequired: boolean,
        preparedDescriptor: Instance | undefined,
    ): Promise<void> {
        if (!instance.enabled) {
            if (descriptor !== undefined) {
                await this.#instanceRegistry.remove(
                    instance.name,
                    descriptor,
                    async (retiring) =>
                        await this.#retireRuntimeInstance(retiring),
                );
                this.#instanceChanges.publish("registry");
            }
            return;
        }
        if (descriptor === undefined) {
            if (preparedDescriptor !== undefined) {
                this.#instanceRegistry.add(preparedDescriptor);
                this.#instanceChanges.publish("registry");
            }
            return;
        }
        if (rebuildRequired) {
            if (preparedDescriptor === undefined)
                throw new Error(
                    `Missing prepared descriptor for ${instance.name}.`,
                );
            await this.#instanceRegistry.remove(
                instance.name,
                descriptor,
                async (retiring) =>
                    await this.#retireRuntimeInstance(retiring),
            );
            this.#instanceChanges.publish("registry");
            return;
        }
        descriptor.update(instance);
        await descriptor.worker.reconfigure(toWorkerReconfigureInput(instance));
        this.#instanceChanges.publish("registry");
    }

    async syncMcpEndpoint(instanceName: string): Promise<void> {
        if (this.#mcp === undefined) return;
        const config = this.#engine.current;
        const instance = config.instances.find(
            (entry) => entry.name === instanceName,
        );
        const descriptor = this.#instanceRegistry.get(instanceName);
        if (
            !config.mcp.enabled ||
            instance === undefined ||
            !instance.enabled ||
            !instance.mcp.enabled ||
            descriptor === undefined
        ) {
            this.#mcp.unregisterInstance(instanceName);
            return;
        }
        this.#mcp.registerInstance(
            instanceName,
            instance.mcp.auth,
        );
    }

    async #persistInstanceConfig(
        config: ControlConfig,
        preparedDescriptor: Instance | undefined,
        currentDescriptor: InstanceDescriptor,
    ): Promise<void> {
        try {
            await this.#engine.persist(config);
        } catch (error) {
            if (
                preparedDescriptor === undefined ||
                preparedDescriptor === currentDescriptor
            )
                throw error;
            try {
                await closeDescriptorResourcesBestEffort(
                    preparedDescriptor,
                    this.#finalizeRuntimeInstance,
                );
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    `Configuration persistence failed and prepared instance ${preparedDescriptor.name} cleanup was incomplete.`,
                );
            }
            throw error;
        }
    }

    async #cleanupCommittedInstanceChange(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: InstanceDescriptor,
        preparedDescriptor: Instance | undefined,
        rebuildRequired: boolean,
    ): Promise<unknown[]> {
        const failures = await this.#retirement.cleanupCommittedInstanceChange(
            existing,
            next,
            descriptor,
        );

        if (
            existing !== undefined &&
            next !== undefined &&
            !next.enabled &&
            descriptor !== undefined
        ) {
            let stopped =
                descriptor.worker.managementMode === "selfManaged";
            if (!stopped) {
                try {
                    await descriptor.worker.stop();
                    stopped = true;
                } catch (error) {
                    failures.push(error);
                }
            }
            if (stopped) {
                await closeDescriptorResourcesBestEffort(
                    descriptor,
                    this.#finalizeRuntimeInstance,
                )
                    .then(() => this.#cleanup.releaseDescriptor(existing.name))
                    .catch((error) => failures.push(error));
            }
        }

        if (
            rebuildRequired &&
            existing !== undefined &&
            descriptor !== undefined &&
            preparedDescriptor !== undefined &&
            descriptor !== preparedDescriptor
        ) {
            if (failures.length > 0) {
                await closeDescriptorResourcesBestEffort(
                    preparedDescriptor,
                    this.#finalizeRuntimeInstance,
                ).catch((error) => failures.push(error));
                await closeDescriptorResourcesBestEffort(
                    descriptor,
                    this.#finalizeRuntimeInstance,
                ).catch((error) => failures.push(error));
                return failures;
            }
            try {
                this.#instanceRegistry.add(preparedDescriptor);
                this.#instanceChanges.publish("registry");
                await this.syncMcpEndpoint(existing.name);
            } catch (error) {
                failures.push(error);
                if (
                    this.#instanceRegistry.get(existing.name) ===
                    preparedDescriptor
                ) {
                    await this.#instanceRegistry
                        .remove(existing.name, preparedDescriptor, async (retiring) =>
                            await this.#retireRuntimeInstance(retiring),
                        )
                        .catch((cleanupError) =>
                            failures.push(cleanupError),
                        );
                    this.#instanceChanges.publish("registry");
                    await this.syncMcpEndpoint(existing.name).catch(
                        (cleanupError) => failures.push(cleanupError),
                    );
                }
                await closeDescriptorResourcesBestEffort(
                    preparedDescriptor,
                    this.#finalizeRuntimeInstance,
                ).catch((cleanupError) => failures.push(cleanupError));
            }
            await closeDescriptorResourcesBestEffort(
                descriptor,
                this.#finalizeRuntimeInstance,
            ).catch(
                (error) => failures.push(error),
            );
        }
        return failures;
    }

    async #cleanupCommittedInstanceChangeWithDebt(
        existing: ControlConfig["instances"][number],
        next: ControlConfig["instances"][number],
        descriptor: InstanceDescriptor,
        preparedDescriptor: PreparedInstanceDescriptor | undefined,
        rebuildRequired: boolean,
    ): Promise<void> {
        if (
            existing.enabled &&
            !next.enabled &&
            descriptor !== undefined
        ) {
            this.#cleanup.retainDescriptor(existing.name, descriptor);
        }
        await this.#cleanup.cleanupCommittedInstanceChangeWithDebt(
            existing,
            next,
            descriptor,
            preparedDescriptor,
            rebuildRequired,
            () =>
                this.#cleanupCommittedInstanceChange(
                    existing,
                    next,
                    descriptor,
                    preparedDescriptor,
                    rebuildRequired,
                ),
        );
    }

    #assertInstanceStopped(instance: string, operation: string): void {
        const descriptor = this.#instanceRegistry.get(instance);
        if (descriptor === undefined) return;
        const snapshot = descriptor.worker.snapshot();
        if (snapshot.daemonState === "stopped") return;
        throw createRemoteError({
            code: runtimeErrorCodes.instanceConflict,
            details: { instance, operation, status: snapshot.status },
            message: `Instance ${instance} must be stopped before ${operation}.`,
            retryable: false,
        });
    }
}

function missingInstance(instanceName: string): Error {
    return createRemoteError({
        code: controlErrorCodes.instanceNotFound,
        details: { instance: instanceName },
        message: `Instance ${instanceName} was not found.`,
        retryable: false,
    });
}
