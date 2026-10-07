import type { InstanceRegistry } from "../../Registry.js";
import { createRemoteError, controlErrorCodes, parseConfigInstanceTargetRequest, type ControlConfig, type JsonValue, } from "@portable-devshell/shared";
import type { Instance } from "@portable-devshell/core";
import { InstanceRetirementNotification } from "./Notification.js";
import { assertInstanceDeletable, retireInstanceForDelete } from "./Runtime.js";
import type { ConfigEngine } from "../../../config/engine/index.js";
import type { InstanceEditorCoordinatorOptions } from "../Options.js";
import { InstanceChangeHub } from "../../Change.js";
import { closeDescriptorResourcesBestEffort } from "./State.js";
import {
    warnCommittedCleanupFailures,
    type InstanceCleanupDebt,
} from "./Debt.js";

type InstanceDescriptor = Instance | undefined;

export class InstanceRetirementCoordinator {
    readonly notification = new InstanceRetirementNotification();
    readonly #detachContextInstance?: (instance: string) => Promise<void>;

    readonly #reconcileContextInstanceCleanup?: (
        instance: string,
        descriptor?: InstanceDescriptor,
    ) => Promise<void>;

    readonly #engine: ConfigEngine;

    readonly #mcp: InstanceEditorCoordinatorOptions["mcp"];

    readonly #instanceChanges: InstanceChangeHub;

    readonly #instanceRegistry: InstanceRegistry;
    readonly #createRuntimeInstance: InstanceEditorCoordinatorOptions["createRuntimeInstance"];
    readonly #finalizeRuntimeInstance: InstanceEditorCoordinatorOptions["finalizeRuntimeInstance"];

    constructor(options: InstanceEditorCoordinatorOptions) {
        this.#detachContextInstance = options.detachContextInstance;
        this.#reconcileContextInstanceCleanup =
            options.reconcileContextInstanceCleanup;
        this.#engine = options.engine;
        this.#mcp = options.mcp;
        this.#instanceChanges = options.instanceChanges;
        this.#instanceRegistry = options.instanceRegistry;
        this.#createRuntimeInstance = options.createRuntimeInstance;
        this.#finalizeRuntimeInstance = options.finalizeRuntimeInstance;
    }

    async deleteInstance(
        params: JsonValue | undefined,
        cleanup: InstanceCleanupDebt,
    ): Promise<JsonValue> {
        return await this.#engine.runExclusive(
            async () => await this.#deleteInstance(params, cleanup),
        );
    }

    async #deleteInstance(
        params: JsonValue | undefined,
        cleanup: InstanceCleanupDebt,
    ): Promise<JsonValue> {
        const { instanceName } = this.#engine.readInput(() =>
            parseConfigInstanceTargetRequest(params),
        );
        const currentConfig = this.#engine.current;
        const existing = currentConfig.instances.find(
            (entry) => entry.name === instanceName,
        );
        if (existing === undefined) {
            throw createRemoteError({
                code: controlErrorCodes.instanceNotFound,
                details: { instance: instanceName },
                message: `Instance ${instanceName} was not found.`,
                retryable: false,
            });
        }
        await cleanup.assertInstanceCleanupSettled(instanceName);

        const descriptor = this.#instanceRegistry.get(instanceName);
        const skipRuntimeRetirement = assertInstanceDeletable(
            instanceName,
            descriptor,
        );
        const nextConfig = this.#engine.validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.filter(
                (entry) => entry.name !== instanceName,
            ),
        });

        await this.#engine.persist(nextConfig);
        try {
            await cleanup.recordDebt({
                instance: existing,
                operation: "delete",
                ...(skipRuntimeRetirement
                    ? { skipRuntimeRetirement: true }
                    : {}),
            });
        } catch (error) {
            try {
                await this.#engine.persist(currentConfig);
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    `Instance ${instanceName} deletion could not persist cleanup debt or restore configuration.`,
                );
            }
            throw error;
        }
        const cleanupFailures: unknown[] = [];
        if (descriptor !== undefined) {
            cleanup.retainDescriptor(instanceName, descriptor);
            await this.#instanceRegistry
                .remove(instanceName, descriptor)
                .catch((error) => cleanupFailures.push(error));
            this.#instanceChanges.publish("registry");
        }
        try {
            this.#mcp?.unregisterInstance(instanceName);
        } catch (error) {
            cleanupFailures.push(error);
        }
        cleanupFailures.push(
            ...(await this.cleanupCommittedDelete(
                existing,
                descriptor,
                skipRuntimeRetirement,
                cleanup,
            )),
        );
        if (cleanupFailures.length === 0) {
            await cleanup
                .clearDebt(instanceName)
                .catch((error) => cleanupFailures.push(error));
        }
        warnCommittedCleanupFailures(instanceName, "delete", cleanupFailures);
        return this.#engine.finalizeApplyResult(currentConfig, nextConfig, [
            { kind: "instance.deleted", target: instanceName },
        ]);
    }

    async cleanupCommittedInstanceChange(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: InstanceDescriptor,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        if (
            existing !== undefined &&
            next !== undefined &&
            descriptor !== undefined &&
            existing.enabled
        ) {
            const instanceDisabled = !next.enabled;
            if (!descriptor.generation.active) {
                await this.notification
                    .retireGenerationResources(existing)
                    .catch((error) => failures.push(error));
                if (instanceDisabled) {
                    failures.push(
                        ...(await this.notification.retireDisable(existing)),
                    );
                }
            }
            const workspaceDisabled =
                existing.workspace.enabled && !next.workspace.enabled;
            if (workspaceDisabled || instanceDisabled) {
                await this.#mcp
                    ?.retireMcpApp(existing.name)
                    .catch((error) => failures.push(error));
            }
            if (instanceDisabled) {
                await this.notification
                    .notifyDisabled(existing)
                    .catch((error) => failures.push(error));
            }
        }

        return failures;
    }

    async cleanupCommittedDelete(
        existing: ControlConfig["instances"][number],
        descriptor: InstanceDescriptor,
        skipRuntimeRetirement: boolean,
        cleanup: InstanceCleanupDebt,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        const cleanupDescriptor =
            descriptor ??
            (this.#reconcileContextInstanceCleanup === undefined
                ? undefined
                : this.#createRuntimeInstance(existing));
        if (cleanupDescriptor !== undefined) {
            cleanup.retainDescriptor(existing.name, cleanupDescriptor);
        }
        try {
            await this.#detachContextInstance?.(existing.name);
        } catch (error) {
            failures.push(error);
            return failures;
        }
        try {
            await this.#reconcileContextInstanceCleanup?.(
                existing.name,
                cleanupDescriptor,
            );
        } catch (error) {
            failures.push(error);
            return failures;
        }
        if (descriptor !== undefined && !descriptor.generation.active) {
            await this.notification
                .retireGenerationResources(existing)
                .catch((error) => failures.push(error));
            failures.push(...(await this.notification.retireDelete(existing)));
        }
        if (descriptor === undefined) {
            await this.notification
                .retireGenerationResources(existing)
                .catch((error) => failures.push(error));
            failures.push(...(await this.notification.retireDelete(existing)));
        }
        let workerRetirementSucceeded = cleanupDescriptor === undefined;
        if (cleanupDescriptor !== undefined) {
            try {
                await retireInstanceForDelete(
                    cleanupDescriptor,
                    skipRuntimeRetirement,
                );
                workerRetirementSucceeded = true;
            } catch (error) {
                failures.push(error);
            }
        }
        if (cleanupDescriptor !== undefined) {
            if (workerRetirementSucceeded) {
                await closeDescriptorResourcesBestEffort(
                    cleanupDescriptor,
                    this.#finalizeRuntimeInstance,
                )
                    .then(() => cleanup.releaseDescriptor(existing.name))
                    .catch((error) => failures.push(error));
            }
        }

        await this.notification
            .notifyDeleted(existing)
            .catch((error) => failures.push(error));
        return failures;
    }

    async prepareContextCleanup(
        instance: string,
        descriptor: InstanceDescriptor,
    ): Promise<void> {
        await this.#detachContextInstance?.(instance);
        await this.#reconcileContextInstanceCleanup?.(instance, descriptor);
    }
}
