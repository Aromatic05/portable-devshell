import type { McpHost, McpInstanceGateway } from "@portable-devshell/mcp";
import {
    applyConfigInstancePatch,
    createError,
    errorCodes,
    normalizeConfigInstanceDraft,
    parseConfigInstanceTargetRequest,
    parseConfigUpdateInstanceRequest,
    type ConfigUpdateInstanceRequest,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";

import { InstanceFactory } from "../../instance/create/Factory.js";
import type { InstanceRegistry } from "../../instance/registry/Registry.js";
import { McpEndpointFactory } from "../../../composition/mcp/Endpoint.js";
import {
    type ConfigEngine,
    type ConfigRuntimeChangeSet,
} from "../Engine.js";
import {
    requiresWorkerRebuild,
    toWorkerReconfigureInput,
} from "../editor/Result.js";

export interface InstanceConfigCoordinatorOptions {
    cleanupDebtFile?: string;
    engine: ConfigEngine;
    getMcpHost?: () => McpHost | undefined;
    getMcpInstanceGateway?: () => McpInstanceGateway | undefined;
    instanceConfigMapper?: InstanceFactory;
    instanceRegistry: InstanceRegistry;
    mcpEndpointConfigMapper?: McpEndpointFactory;
}

type InstanceConfig = ControlConfig["instances"][number];
type InstanceDescriptor = ReturnType<InstanceRegistry["get"]>;
type PreparedInstanceDescriptor = ReturnType<InstanceFactory["map"]>;

export interface InstanceConfigUpdatePlan {
    readonly authChanged: boolean;
    readonly descriptor: InstanceDescriptor;
    readonly existing: InstanceConfig;
    readonly instance: InstanceConfig;
    readonly rebuildRequired: boolean;
    readonly target: string;
}

import {
    InstanceCleanupDebtStore,
    type InstanceCleanupDebtRecord,
} from "./CleanupDebt.js";

export class InstanceConfigCoordinator {
    readonly #cleanupDebts: InstanceCleanupDebtStore;
    readonly #engine: ConfigEngine;
    readonly #getMcpHost: () => McpHost | undefined;
    readonly #getMcpInstanceGateway: () => McpInstanceGateway | undefined;
    readonly #instanceConfigMapper: InstanceFactory;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #instanceDisableRetirements = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #instanceDisabled = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #instanceDeleted = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #instanceDeleteRetirements = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #instanceGenerationRetirements = new Set<
        (instance: ControlConfig["instances"][number]) => Promise<void>
    >();
    readonly #mcpEndpointConfigMapper: McpEndpointFactory;

    constructor(options: InstanceConfigCoordinatorOptions) {
        this.#cleanupDebts = new InstanceCleanupDebtStore(
            options.cleanupDebtFile,
        );
        this.#engine = options.engine;
        this.#getMcpHost = options.getMcpHost ?? (() => undefined);
        this.#getMcpInstanceGateway =
            options.getMcpInstanceGateway ?? (() => undefined);
        this.#instanceConfigMapper =
            options.instanceConfigMapper ?? new InstanceFactory();
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcpEndpointConfigMapper =
            options.mcpEndpointConfigMapper ?? new McpEndpointFactory();
    }

    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceDeleteRetirements.add(retire);
        return () => this.#instanceDeleteRetirements.delete(retire);
    }

    registerInstanceDisableRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceDisableRetirements.add(retire);
        return () => this.#instanceDisableRetirements.delete(retire);
    }

    registerInstanceGenerationRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceGenerationRetirements.add(retire);
        return () => this.#instanceGenerationRetirements.delete(retire);
    }

    registerInstanceDisabled(
        listener: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceDisabled.add(listener);
        return () => this.#instanceDisabled.delete(listener);
    }

    registerInstanceDeleted(
        listener: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceDeleted.add(listener);
        return () => this.#instanceDeleted.delete(listener);
    }

    async assertInstanceCleanupSettled(instance: string): Promise<void> {
        if ((await this.#cleanupDebts.get(instance)) === undefined) return;
        if (this.#instanceRegistry.get(instance) === undefined) {
            await this.reconcileCleanupDebt(instance);
        }
        if ((await this.#cleanupDebts.get(instance)) === undefined) return;
        throw createError({
            code: errorCodes.instanceConflict,
            details: { instance, operation: "cleanup" },
            message: `Instance ${instance} still has incomplete lifecycle cleanup.`,
            retryable: true,
        });
    }

    async reconcileCleanupDebt(instance?: string): Promise<void> {
        for (const record of await this.#cleanupDebts.list()) {
            if (instance !== undefined && record.instance.name !== instance)
                continue;
            const failures = await this.#reconcileCleanupRecord(record);
            if (failures.length === 0) {
                await this.#cleanupDebts.clear(record.instance.name);
                continue;
            }
            this.#warnCommittedCleanupFailures(
                record.instance.name,
                record.operation === "delete" ? "delete" : "update",
                failures,
            );
        }
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
            await this.assertInstanceCleanupSettled(existing.name);
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
        if (plan.rebuildRequired)
            this.#assertInstanceStopped(plan.target, "update");
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

    async deleteInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#engine.runExclusive(
            async () => await this.#deleteInstance(params),
        );
    }

    async #deleteInstance(params: JsonValue | undefined): Promise<JsonValue> {
        const { instanceName } = this.#engine.readInput(() =>
            parseConfigInstanceTargetRequest(params),
        );
        const currentConfig = this.#engine.current;
        const existing = currentConfig.instances.find(
            (entry) => entry.name === instanceName,
        );
        if (existing === undefined) throw missingInstance(instanceName);
        await this.assertInstanceCleanupSettled(instanceName);

        const skipRuntimeRetirement =
            this.#assertInstanceDeletable(instanceName);
        const descriptor = this.#instanceRegistry.get(instanceName);
        const nextConfig = this.#engine.validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.filter(
                (entry) => entry.name !== instanceName,
            ),
        });

        await this.#engine.persist(nextConfig);
        const cleanupFailures: unknown[] = [];
        if (descriptor !== undefined) {
            await this.#instanceRegistry
                .retireGeneration(instanceName, descriptor)
                .catch((error) => cleanupFailures.push(error));
        }
        let debtPersisted = false;
        await this.#cleanupDebts
            .put({
                instance: existing,
                operation: "delete",
                ...(skipRuntimeRetirement
                    ? { skipRuntimeRetirement: true }
                    : {}),
            })
            .then(() => {
                debtPersisted = true;
            })
            .catch((error) => cleanupFailures.push(error));
        try {
            this.#getMcpHost()?.unregisterInstance(instanceName);
        } catch (error) {
            cleanupFailures.push(error);
        }
        cleanupFailures.push(
            ...(await this.#cleanupCommittedDelete(
                existing,
                descriptor,
                skipRuntimeRetirement,
            )),
        );
        if (debtPersisted && cleanupFailures.length === 0) {
            await this.#cleanupDebts
                .clear(instanceName)
                .catch((error) => cleanupFailures.push(error));
        }
        this.#warnCommittedCleanupFailures(
            instanceName,
            "delete",
            cleanupFailures,
        );
        return this.#engine.finalizeApplyResult(currentConfig, nextConfig, [
            { kind: "instance.deleted", target: instanceName },
        ]);
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
            await this.assertInstanceCleanupSettled(instanceName);
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

    async #retireStateForDelete(
        descriptor: ReturnType<InstanceRegistry["get"]>,
        skipRuntimeRetirement = false,
    ): Promise<void> {
        if (descriptor === undefined) return;
        const reason = `Instance ${descriptor.name} was deleted.`;
        const failures: unknown[] = [];

        try {
            for (const approval of await descriptor.worker.listApprovals()) {
                if (approval.status !== "pending") continue;
                await descriptor.worker
                    .cancelApproval(approval.approvalId, reason)
                    .catch((error) => failures.push(error));
            }
        } catch (error) {
            failures.push(error);
        }

        if (descriptor.wait !== undefined) {
            try {
                for (const wait of await descriptor.wait.list()) {
                    if (
                        wait.status !== "waiting" &&
                        wait.status !== "detached" &&
                        wait.status !== "resolved"
                    )
                        continue;
                    try {
                        if (wait.status === "resolved")
                            await descriptor.wait.consume(wait.waitId);
                        else await descriptor.wait.cancel(wait.waitId);
                    } catch (error) {
                        let current;
                        try {
                            current = await descriptor.wait.get(wait.waitId);
                        } catch (readError) {
                            failures.push(error, readError);
                            continue;
                        }
                        if (
                            current === undefined ||
                            current.status === "cancelled" ||
                            current.status === "consumed"
                        )
                            continue;
                        if (
                            current.status === "resolved" &&
                            wait.status !== "resolved"
                        ) {
                            try {
                                await descriptor.wait.consume(wait.waitId);
                                continue;
                            } catch (consumeError) {
                                failures.push(error, consumeError);
                                continue;
                            }
                        }
                        failures.push(error);
                    }
                }
            } catch (error) {
                failures.push(error);
            }
        }

        await descriptor.goal.stopAll().catch((error) => failures.push(error));
        await descriptor.todo.cancelAll().catch((error) => failures.push(error));
        if (!skipRuntimeRetirement) {
            await descriptor.worker
                .retireRuntime()
                .catch((error) => failures.push(error));
        }
        await descriptor.worker
            .retireProviderResources()
            .catch((error) => failures.push(error));
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Instance ${descriptor.name} delete cleanup was incomplete.`,
            );
    }

    async #cleanupCommittedInstanceChange(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: ReturnType<InstanceRegistry["get"]>,
        preparedDescriptor: ReturnType<InstanceFactory["map"]> | undefined,
        rebuildRequired: boolean,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        if (
            existing !== undefined &&
            next !== undefined &&
            descriptor !== undefined &&
            existing.enabled
        ) {
            const instanceDisabled = !next.enabled;
            const workspaceDisabled =
                existing.workspace.enabled && !next.workspace.enabled;
            if (workspaceDisabled || instanceDisabled) {
                await this.#getMcpHost()
                    ?.retireWorkspaceApp(existing.name)
                    .catch((error) => failures.push(error));
            }
            if (instanceDisabled) {
                await this.#retireGenerationResources(existing).catch((error) =>
                    failures.push(error),
                );
                this.#instanceRegistry.retireConnectionReferences(
                    descriptor.name,
                    descriptor.worker,
                );
                if (
                    descriptor.worker.managementMode !== "selfManaged" &&
                    descriptor.worker.snapshot().daemonState !== "stopped"
                ) {
                    await descriptor.worker
                        .stop()
                        .catch((error) => failures.push(error));
                }
                for (const retire of [...this.#instanceDisableRetirements]) {
                    await retire(existing).catch((error) => failures.push(error));
                }
                try {
                    for (const approval of await descriptor.worker.listApprovals()) {
                        if (approval.status !== "pending") continue;
                        await descriptor.worker
                            .cancelApproval(
                                approval.approvalId,
                                `Instance ${descriptor.name} was disabled before approval.`,
                            )
                            .catch((error) => failures.push(error));
                    }
                } catch (error) {
                    failures.push(error);
                }
                if (descriptor.wait !== undefined) {
                    try {
                        for (const wait of await descriptor.wait.list()) {
                            if (
                                wait.status !== "waiting" &&
                                wait.status !== "detached"
                            )
                                continue;
                            await descriptor.wait
                                .cancel(wait.waitId)
                                .catch((error) => failures.push(error));
                        }
                    } catch (error) {
                        failures.push(error);
                    }
                }
                await this.#notifyInstanceLifecycle(
                    this.#instanceDisabled,
                    existing,
                ).catch((error) => failures.push(error));
            }
        }

        if (
            rebuildRequired &&
            existing !== undefined &&
            descriptor !== undefined &&
            preparedDescriptor !== undefined &&
            descriptor !== preparedDescriptor
        ) {
            let generationCleanupFailed = false;
            await this.#retireGenerationResources(existing).catch((error) => {
                generationCleanupFailed = true;
                failures.push(error);
            });
            this.#instanceRegistry.retireConnectionReferences(
                descriptor.name,
                descriptor.worker,
            );
            if (!generationCleanupFailed) {
                try {
                    this.#instanceRegistry.add(preparedDescriptor);
                    await this.#syncMcpEndpoint(existing.name);
                } catch (error) {
                    failures.push(error);
                    if (
                        this.#instanceRegistry.get(existing.name) ===
                        preparedDescriptor
                    ) {
                        await this.#instanceRegistry
                            .retireGeneration(existing.name, preparedDescriptor)
                            .catch((cleanupError) =>
                                failures.push(cleanupError),
                            );
                        this.#instanceRegistry.retireConnectionReferences(
                            preparedDescriptor.name,
                            preparedDescriptor.worker,
                        );
                        await this.#syncMcpEndpoint(existing.name).catch(
                            (cleanupError) => failures.push(cleanupError),
                        );
                    }
                    await closeDescriptorResourcesBestEffort(
                        preparedDescriptor,
                    ).catch((cleanupError) => failures.push(cleanupError));
                }
            } else {
                await closeDescriptorResourcesBestEffort(preparedDescriptor).catch(
                    (cleanupError) => failures.push(cleanupError),
                );
            }
            await closeDescriptorResourcesBestEffort(descriptor).catch((error) =>
                failures.push(error),
            );
        }
        return failures;
    }

    async #cleanupCommittedInstanceChangeWithDebt(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: ReturnType<InstanceRegistry["get"]>,
        preparedDescriptor: ReturnType<InstanceFactory["map"]> | undefined,
        rebuildRequired: boolean,
    ): Promise<void> {
        const debt: InstanceCleanupDebtRecord | undefined =
            existing !== undefined &&
            next !== undefined &&
            existing.enabled &&
            !next.enabled
                ? {
                      instance: existing,
                      operation: "disable",
                  }
                : existing !== undefined &&
                    next !== undefined &&
                    existing.enabled &&
                    next.enabled &&
                    rebuildRequired &&
                    descriptor !== undefined &&
                    preparedDescriptor !== undefined &&
                    descriptor !== preparedDescriptor
                  ? {
                        instance: existing,
                        operation: "rebuild",
                    }
                : undefined;
        const failures: unknown[] = [];
        let debtPersisted = false;
        if (debt !== undefined) {
            await this.#cleanupDebts
                .put(debt)
                .then(() => {
                    debtPersisted = true;
                })
                .catch((error) => failures.push(error));
        }
        const cleanupFailures = await this.#cleanupCommittedInstanceChange(
            existing,
            next,
            descriptor,
            preparedDescriptor,
            rebuildRequired,
        );
        failures.push(...cleanupFailures);
        const cleanupSettled =
            debt?.operation === "rebuild"
                ? preparedDescriptor !== undefined &&
                  this.#instanceRegistry.get(debt.instance.name) ===
                      preparedDescriptor
                : cleanupFailures.length === 0;
        if (debt !== undefined && debtPersisted && cleanupSettled) {
            await this.#cleanupDebts
                .clear(debt.instance.name)
                .catch((error) => failures.push(error));
        }
        this.#warnCommittedCleanupFailures(
            next?.name ?? existing?.name ?? "unknown",
            "update",
            failures,
        );
    }

    async #cleanupCommittedDelete(
        existing: ControlConfig["instances"][number],
        descriptor: ReturnType<InstanceRegistry["get"]>,
        skipRuntimeRetirement: boolean,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        await this.#retireGenerationResources(existing).catch((error) =>
            failures.push(error),
        );
        for (const retire of [...this.#instanceDeleteRetirements]) {
            await retire(existing).catch((error) => failures.push(error));
        }
        await this.#retireStateForDelete(descriptor, skipRuntimeRetirement).catch(
            (error) => failures.push(error),
        );
        if (descriptor !== undefined) {
            await closeDescriptorResourcesBestEffort(descriptor).catch((error) =>
                failures.push(error),
            );
        }
        await this.#getMcpHost()
            ?.contextAdmin.detachInstance(existing.name)
            .catch((error) => failures.push(error));
        await this.#notifyInstanceLifecycle(this.#instanceDeleted, existing).catch(
            (error) => failures.push(error),
        );
        if (descriptor !== undefined) {
            this.#instanceRegistry.retireConnectionReferences(
                descriptor.name,
                descriptor.worker,
            );
        }
        return failures;
    }

    async #reconcileCleanupRecord(
        record: InstanceCleanupDebtRecord,
    ): Promise<unknown[]> {
        if (record.operation === "rebuild") {
            return await this.#reconcileRebuildCleanup(record);
        }
        const failures: unknown[] = [];
        const descriptor = this.#instanceConfigMapper.map(record.instance);
        await this.#retireGenerationResources(record.instance).catch((error) =>
            failures.push(error),
        );
        if (record.operation === "disable") {
            await this.#getMcpHost()
                ?.retireWorkspaceApp(record.instance.name)
                .catch((error) => failures.push(error));
            for (const retire of [...this.#instanceDisableRetirements]) {
                await retire(record.instance).catch((error) =>
                    failures.push(error),
                );
            }
            if (descriptor.worker.managementMode !== "selfManaged") {
                await descriptor.worker
                    .retireRuntime()
                    .catch((error) => failures.push(error));
            }
            await this.#notifyInstanceLifecycle(
                this.#instanceDisabled,
                record.instance,
            ).catch((error) => failures.push(error));
        } else {
            for (const retire of [...this.#instanceDeleteRetirements]) {
                await retire(record.instance).catch((error) =>
                    failures.push(error),
                );
            }
            if (record.skipRuntimeRetirement !== true) {
                await descriptor.worker
                    .retireRuntime()
                    .catch((error) => failures.push(error));
            }
            await descriptor.worker
                .retireProviderResources()
                .catch((error) => failures.push(error));
            await this.#getMcpHost()
                ?.contextAdmin.detachInstance(record.instance.name)
                .catch((error) => failures.push(error));
            await this.#notifyInstanceLifecycle(
                this.#instanceDeleted,
                record.instance,
            ).catch((error) => failures.push(error));
        }
        await closeDescriptorResourcesBestEffort(descriptor).catch((error) =>
            failures.push(error),
        );
        return failures;
    }

    async #reconcileRebuildCleanup(
        record: InstanceCleanupDebtRecord,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        let candidate = this.#instanceRegistry.get(record.instance.name);
        if (candidate !== undefined) {
            try {
                await this.#instanceRegistry.retireGeneration(
                    record.instance.name,
                    candidate,
                );
                this.#instanceRegistry.retireConnectionReferences(
                    candidate.name,
                    candidate.worker,
                );
            } catch (error) {
                failures.push(error);
                return failures;
            }
        }

        await this.#retireGenerationResources(record.instance).catch((error) =>
            failures.push(error),
        );
        if (failures.length > 0) {
            if (candidate !== undefined) {
                await closeDescriptorResourcesBestEffort(candidate).catch((error) =>
                    failures.push(error),
                );
            }
            return failures;
        }

        if (candidate === undefined) {
            const configured = this.#engine.current.instances.find(
                (instance) =>
                    instance.name === record.instance.name && instance.enabled,
            );
            if (configured !== undefined) {
                candidate = this.#instanceConfigMapper.map(configured);
            }
        }
        if (candidate === undefined) return failures;

        try {
            this.#instanceRegistry.add(candidate);
            await this.#syncMcpEndpoint(record.instance.name);
        } catch (error) {
            failures.push(error);
            if (this.#instanceRegistry.get(record.instance.name) === candidate) {
                await this.#instanceRegistry
                    .retireGeneration(record.instance.name, candidate)
                    .catch((cleanupError) => failures.push(cleanupError));
                this.#instanceRegistry.retireConnectionReferences(
                    candidate.name,
                    candidate.worker,
                );
                await this.#syncMcpEndpoint(record.instance.name).catch(
                    (cleanupError) => failures.push(cleanupError),
                );
            }
            await closeDescriptorResourcesBestEffort(candidate).catch(
                (cleanupError) => failures.push(cleanupError),
            );
        }
        return failures;
    }

    #warnCommittedCleanupFailures(
        instance: string,
        operation: "delete" | "update",
        failures: readonly unknown[],
    ): void {
        if (failures.length === 0) return;
        console.warn(
            new AggregateError(
                [...failures],
                `Instance ${instance} ${operation} committed but cleanup was incomplete.`,
            ),
        );
    }

    async #retireGenerationResources(
        instance: ControlConfig["instances"][number],
    ): Promise<void> {
        const failures: unknown[] = [];
        for (const retire of [...this.#instanceGenerationRetirements]) {
            await retire(instance).catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Instance ${instance.name} generation retirement was incomplete.`,
            );
        }
    }

    async #applyPersistedChanges(input: {
        currentConfig: ControlConfig;
        descriptor: ReturnType<InstanceRegistry["get"]>;
        existing?: ControlConfig["instances"][number];
        instance?: ControlConfig["instances"][number];
        nextConfig: ControlConfig;
        preparedDescriptor?: ReturnType<InstanceFactory["map"]>;
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
                await this.#syncMcpEndpoint(input.instance.name);
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
                await this.#engine.persist(input.currentConfig).catch(
                    (rollbackError) => failures.push(rollbackError),
                );
            }
            if (input.existing !== undefined && input.instance !== undefined) {
                await this.#restoreInstanceRuntime(
                    input.existing,
                    input.descriptor,
                    input.preparedDescriptor,
                ).catch((rollbackError) => failures.push(rollbackError));
                try {
                    await this.#syncMcpEndpoint(input.existing.name);
                } catch (rollbackError) {
                    failures.push(rollbackError);
                }
            } else if (input.preparedDescriptor !== undefined) {
                await closeDescriptorResourcesBestEffort(
                    input.preparedDescriptor,
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
        descriptor: ReturnType<InstanceRegistry["get"]>,
        preparedDescriptor: ReturnType<InstanceFactory["map"]> | undefined,
    ): Promise<void> {
        const failures: unknown[] = [];
        if (descriptor === undefined) {
            const current = this.#instanceRegistry.get(existing.name);
            if (current !== undefined)
                await this.#instanceRegistry
                    .retireGeneration(existing.name, current)
                    .catch((error) => failures.push(error));
        } else {
            try {
                const current = this.#instanceRegistry.get(existing.name);
                if (current !== undefined && current !== descriptor) {
                    await this.#instanceRegistry.retireGeneration(
                        existing.name,
                        current,
                    );
                }
                await descriptor.worker.reconfigure(
                    toWorkerReconfigureInput(existing),
                );
                descriptor.mcpContextMode = existing.mcp.contextMode;
                descriptor.enabled = existing.enabled;
                descriptor.mcpEnabled = existing.mcp.enabled;
                descriptor.mcpPath = existing.mcp.path;
                descriptor.modelExtensions = [...existing.extensions.model];
                if (this.#instanceRegistry.get(existing.name) === descriptor)
                    this.#instanceRegistry.update(descriptor);
                else this.#instanceRegistry.add(descriptor);
            } catch (error) {
                failures.push(error);
            }
        }
        if (
            preparedDescriptor !== undefined &&
            preparedDescriptor !== descriptor
        ) {
            await closeDescriptorResourcesBestEffort(preparedDescriptor).catch(
                (error) => failures.push(error),
            );
        }
        if (failures.length > 0)
            throw new AggregateError(
                failures,
                `Failed to restore instance ${existing.name}.`,
            );
    }

    #prepareInstanceDescriptor(
        instance: ControlConfig["instances"][number],
        descriptor: ReturnType<InstanceRegistry["get"]>,
        rebuildRequired: boolean,
    ): ReturnType<InstanceFactory["map"]> | undefined {
        if (!instance.enabled) return undefined;
        if (descriptor === undefined || rebuildRequired)
            return this.#instanceConfigMapper.map(instance);
        return undefined;
    }

    async #applyInstanceConfig(
        existing: ControlConfig["instances"][number],
        instance: ControlConfig["instances"][number],
        descriptor: ReturnType<InstanceRegistry["get"]>,
        rebuildRequired: boolean,
        preparedDescriptor: ReturnType<InstanceFactory["map"]> | undefined,
    ): Promise<void> {
        if (!instance.enabled) {
            if (descriptor !== undefined)
                await this.#instanceRegistry.retireGeneration(
                    instance.name,
                    descriptor,
                );
            return;
        }
        if (descriptor === undefined) {
            if (preparedDescriptor !== undefined)
                this.#instanceRegistry.add(preparedDescriptor);
            return;
        }
        if (rebuildRequired) {
            if (preparedDescriptor === undefined)
                throw new Error(
                    `Missing prepared descriptor for ${instance.name}.`,
                );
            await this.#instanceRegistry.retireGeneration(
                instance.name,
                descriptor,
            );
            return;
        }
        await descriptor.worker.reconfigure(toWorkerReconfigureInput(instance));
        descriptor.mcpContextMode = instance.mcp.contextMode;
        descriptor.enabled = true;
        descriptor.mcpEnabled = instance.mcp.enabled;
        descriptor.mcpPath = instance.mcp.path;
        descriptor.modelExtensions = [...instance.extensions.model];
        this.#instanceRegistry.update(descriptor);
    }

    async #notifyInstanceLifecycle(
        listeners: ReadonlySet<
            (instance: ControlConfig["instances"][number]) => Promise<void>
        >,
        instance: ControlConfig["instances"][number],
    ): Promise<void> {
        const failures: unknown[] = [];
        for (const listener of [...listeners]) {
            try {
                await listener(instance);
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                `Instance ${instance.name} lifecycle cleanup failed.`,
            );
        }
    }

    async #syncMcpEndpoint(instanceName: string): Promise<void> {
        const host = this.#getMcpHost();
        if (host === undefined) return;
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
            host.unregisterInstance(instanceName);
            return;
        }
        host.registerInstance(
            this.#mcpEndpointConfigMapper.map(
                descriptor,
                this.#getMcpInstanceGateway(),
                instance.mcp.auth,
                instance.workspace.enabled,
            ),
        );
    }

    #assertInstanceDeletable(instanceName: string): boolean {
        const descriptor = this.#instanceRegistry.get(instanceName);
        if (descriptor === undefined) return false;
        const snapshot = descriptor.worker.snapshot();
        if (snapshot.daemonState === "stopped") return false;
        if (
            snapshot.daemonState === "failed" ||
            snapshot.daemonState === "stale"
        )
            return true;
        throw createError({
            code: errorCodes.instanceConflict,
            details: {
                instance: instanceName,
                operation: "delete",
                status: snapshot.status,
            },
            message: `Instance ${instanceName} must be stopped before delete.`,
            retryable: false,
        });
    }

    #assertInstanceStopped(
        instanceName: string,
        operation: "disable" | "update",
    ): void {
        const descriptor = this.#instanceRegistry.get(instanceName);
        if (descriptor === undefined) return;
        const snapshot = descriptor.worker.snapshot();
        if (snapshot.daemonState === "stopped") return;
        throw createError({
            code: errorCodes.instanceConflict,
            details: {
                instance: instanceName,
                operation,
                status: snapshot.status,
            },
            message: `Instance ${instanceName} must be stopped before ${operation}.`,
            retryable: false,
        });
    }

    async #persistInstanceConfig(
        config: ControlConfig,
        preparedDescriptor: ReturnType<InstanceFactory["map"]> | undefined,
        currentDescriptor: ReturnType<InstanceRegistry["get"]>,
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
                await closeDescriptorResourcesBestEffort(preparedDescriptor);
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    `Configuration persistence failed and prepared instance ${preparedDescriptor.name} cleanup was incomplete.`,
                );
            }
            throw error;
        }
    }

}

async function closeDescriptorResourcesBestEffort(
    descriptor: ReturnType<InstanceFactory["map"]>,
): Promise<void> {
    const failures: unknown[] = [];
    const close = (descriptor.worker as { close?: () => Promise<void> }).close;
    if (close !== undefined) {
        await close
            .call(descriptor.worker)
            .catch((error) => failures.push(error));
    }
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Failed to close instance ${descriptor.name} resources.`,
        );
    }
}

function missingInstance(instanceName: string): Error {
    return createError({
        code: errorCodes.instanceMissing,
        details: { instance: instanceName },
        message: `Instance ${instanceName} was not found.`,
        retryable: false,
    });
}
