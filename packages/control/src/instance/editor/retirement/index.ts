import {
    createRemoteError,
    controlErrorCodes,
    parseConfigInstanceTargetRequest,
    type ControlConfig,
    type JsonValue,
    runtimeErrorCodes,
} from "@portable-devshell/shared";
import {
    InstanceFactory,
    type InstanceRegistry,
} from "@portable-devshell/core";
import type { ConfigEngine } from "../../../config/engine/index.js";
import type { InstanceEditorCoordinatorOptions } from "../Options.js";
import { InstanceRetirementNotification } from "./Notification.js";
import {
    InstanceRetirementState,
    closeDescriptorResourcesBestEffort,
} from "./State.js";
import {
    warnCommittedCleanupFailures,
    type InstanceCleanupDebt,
} from "./Debt.js";

type InstanceDescriptor = ReturnType<InstanceRegistry["get"]>;

export class InstanceRetirementCoordinator {
    readonly notification = new InstanceRetirementNotification();
    readonly #state = new InstanceRetirementState();
    readonly #detachContextInstance?: (instance: string) => Promise<void>;

    readonly #reconcileContextInstanceCleanup?: (
        instance: string,
        descriptor?: InstanceDescriptor,
    ) => Promise<void>;

    readonly #engine: ConfigEngine;

    readonly #mcp: InstanceEditorCoordinatorOptions["mcp"];

    readonly #instanceConfigMapper: InstanceFactory;

    readonly #instanceRegistry: InstanceRegistry;

    constructor(options: InstanceEditorCoordinatorOptions) {
        this.#detachContextInstance = options.detachContextInstance;
        this.#reconcileContextInstanceCleanup =
            options.reconcileContextInstanceCleanup;
        this.#engine = options.engine;
        this.#mcp = options.mcp;
        this.#instanceConfigMapper =
            options.instanceConfigMapper ?? new InstanceFactory();
        this.#instanceRegistry = options.instanceRegistry;
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
                .retireGeneration(instanceName, descriptor)
                .catch((error) => cleanupFailures.push(error));
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
        descriptor: ReturnType<InstanceRegistry["get"]>,
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
                await this.#mcp
                    ?.retireMcpApp(existing.name)
                    .catch((error) => failures.push(error));
            }
            if (instanceDisabled) {
                await this.notification
                    .retireGenerationResources(existing)
                    .catch((error) => failures.push(error));
                failures.push(
                    ...(await this.notification.retireDisable(existing)),
                );
                await this.notification
                    .notifyDisabled(existing)
                    .catch((error) => failures.push(error));
            }
        }

        return failures;
    }

    async cleanupCommittedDelete(
        existing: ControlConfig["instances"][number],
        descriptor: ReturnType<InstanceRegistry["get"]>,
        skipRuntimeRetirement: boolean,
        cleanup: InstanceCleanupDebt,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        const cleanupDescriptor =
            descriptor ??
            (this.#reconcileContextInstanceCleanup === undefined
                ? undefined
                : this.#instanceConfigMapper.map(existing));
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
        await this.notification
            .retireGenerationResources(existing)
            .catch((error) => failures.push(error));
        failures.push(...(await this.notification.retireDelete(existing)));
        await this.#state
            .retireForDelete(cleanupDescriptor, skipRuntimeRetirement)
            .catch((error) => failures.push(error));
        if (cleanupDescriptor !== undefined) {
            await closeDescriptorResourcesBestEffort(cleanupDescriptor).catch(
                (error) => failures.push(error),
            );
            cleanup.releaseDescriptor(existing.name);
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
