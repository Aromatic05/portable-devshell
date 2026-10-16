import type { InstanceRegistry } from "../../Registry.js";
import {
    createRemoteError,
    controlErrorCodes,
    parseConfigInstanceTargetRequest,
    type ControlConfig,
    type JsonValue,
} from "@portable-devshell/shared";
import type { Instance } from "@portable-devshell/core";
import { InstanceRetirementHooks } from "./Hooks.js";
import { assertInstanceDeletable } from "./Runtime.js";
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
    readonly hooks = new InstanceRetirementHooks();
    readonly #detachContextInstance?: (instance: string) => Promise<void>;

    readonly #reconcileContextInstanceCleanup: InstanceEditorCoordinatorOptions["reconcileContextInstanceCleanup"];

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
        const skipRuntimeRetirement =
            (descriptor === undefined && existing.provider !== "local") ||
            assertInstanceDeletable(instanceName, descriptor);
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
                .remove(instanceName, descriptor, () =>
                    this.#instanceChanges.publish("registry"),
                )
                .catch((error) => cleanupFailures.push(error));
        }
        try {
            this.#mcp?.unregisterInstance(instanceName);
        } catch (error) {
            cleanupFailures.push(error);
        }
        const retirement = await this.cleanupCommittedDelete(
            existing,
            descriptor,
            skipRuntimeRetirement,
            cleanup,
        );
        cleanupFailures.push(...retirement.failures);
        if (cleanupFailures.length === 0) {
            await cleanup
                .clearDebt(instanceName)
                .catch((error) => cleanupFailures.push(error));
        }
        warnCommittedCleanupFailures(instanceName, "delete", cleanupFailures);
        for (const warning of retirement.warnings)
            console.warn(
                `Instance ${instanceName} remote retirement incomplete:`,
                warning,
            );
        const result = this.#engine.finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "instance.deleted", target: instanceName }],
        );
        return {
            ...(result as Record<string, JsonValue>),
            cleanupPending: cleanupFailures.length > 0,
            ...(retirement.warnings.length === 0
                ? {}
                : {
                      cleanupWarnings: retirement.warnings.map((error) =>
                          error instanceof Error
                              ? error.message
                              : String(error),
                      ),
                  }),
        };
    }

    async cleanupCommittedInstanceChange(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: InstanceDescriptor,
    ): Promise<unknown[]> {
        const failures: unknown[] = [];
        if (existing !== undefined && next !== undefined && existing.enabled) {
            const instanceDisabled = !next.enabled;
            const mcpDisabled = existing.mcp.enabled && !next.mcp.enabled;
            if (descriptor !== undefined && !descriptor.lifecycle.active) {
                await this.hooks
                    .retireGenerationResources(existing)
                    .catch((error) => failures.push(error));
                if (instanceDisabled) {
                    failures.push(
                        ...(await this.hooks.retireDisable(existing)),
                    );
                }
            }
            const workspaceDisabled =
                existing.workspace.enabled && !next.workspace.enabled;
            if (workspaceDisabled || instanceDisabled || mcpDisabled) {
                await this.#mcp
                    ?.retireMcpApp(existing.name)
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
    ): Promise<{ failures: unknown[]; warnings: unknown[] }> {
        const failures: unknown[] = [];
        const warnings: unknown[] = [];
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
            return { failures, warnings };
        }
        try {
            await this.#reconcileContextCleanup(
                existing.name,
                cleanupDescriptor,
            );
        } catch (error) {
            failures.push(error);
            return { failures, warnings };
        }
        await this.#mcp
            ?.retireMcpApp(existing.name)
            .catch((error) => failures.push(error));
        if (descriptor !== undefined && !descriptor.lifecycle.active) {
            await this.hooks
                .retireGenerationResources(existing)
                .catch((error) => failures.push(error));
            failures.push(...(await this.hooks.retireDelete(existing)));
        }
        if (descriptor === undefined) {
            await this.hooks
                .retireGenerationResources(existing)
                .catch((error) => failures.push(error));
            failures.push(...(await this.hooks.retireDelete(existing)));
        }
        let workerRetirementSucceeded = cleanupDescriptor === undefined;
        if (cleanupDescriptor !== undefined) {
            try {
                await cleanupDescriptor.retireWorkerResources(
                    skipRuntimeRetirement,
                );
                workerRetirementSucceeded = true;
            } catch (error) {
                if (existing.provider === "local") failures.push(error);
                else {
                    // Retrying a retired remote generation against a newly
                    // created same-name instance would be destructive.
                    warnings.push(error);
                    workerRetirementSucceeded = true;
                }
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
        return { failures, warnings };
    }

    async prepareContextCleanup(
        instance: string,
        descriptor: InstanceDescriptor,
    ): Promise<void> {
        await this.#detachContextInstance?.(instance);
        await this.#reconcileContextCleanup(instance, descriptor);
    }

    async #reconcileContextCleanup(
        instance: string,
        descriptor: InstanceDescriptor,
    ): Promise<void> {
        const reconcile = this.#reconcileContextInstanceCleanup;
        if (reconcile === undefined) return;
        let needsRemoteWorker = false;
        const requireWorker = async (): Promise<void> => {
            needsRemoteWorker = true;
            throw new Error("Context cleanup requires an Instance Worker.");
        };
        try {
            // A no-op target lets the ledger skip already-settled records,
            // but explicitly defers actual remote releases until a Worker
            // has been acquired. Never pretend a release succeeded.
            await reconcile(instance, {
                releaseAlerts: requireWorker,
                releaseReference: requireWorker,
            });
        } catch (error) {
            if (!needsRemoteWorker || descriptor === undefined) throw error;
            // A cleanup-only Worker is only needed if outstanding Context
            // records actually require a remote release.
            await descriptor.withWorkerForCleanup(async (worker) => {
                await reconcile(instance, worker);
            });
        }
    }
}
