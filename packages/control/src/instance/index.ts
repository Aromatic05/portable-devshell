import { createInstance, type Instance } from "@portable-devshell/core";
import type { ReverseConnections } from "@portable-devshell/core";
import type { ControlConfig, ControlInstanceConfig, Endpoint } from "@portable-devshell/shared";

import { InstanceChangeHub } from "./Change.js";
import type { InstanceEditorCoordinator } from "./editor/index.js";
import { InstanceRegistry } from "./Registry.js";

export interface ControlInstancesRuntime {
    editor: InstanceEditorCoordinator;
    reverseConnections?: ReverseConnections;
    toolCallEndpoint: Endpoint;
}

export class ControlInstances {
    readonly changes = new InstanceChangeHub();
    #editor?: InstanceEditorCoordinator;
    #registry = new InstanceRegistry([]);
    #reverseConnections?: ReverseConnections;
    #toolCallEndpoint?: Endpoint;

    get registry(): InstanceRegistry {
        return this.#registry;
    }

    attachRuntime(runtime: ControlInstancesRuntime): void {
        this.#editor = runtime.editor;
        this.#reverseConnections = runtime.reverseConnections;
        this.#toolCallEndpoint = runtime.toolCallEndpoint;
        for (const instance of this.#registry.list())
            instance.attachToolCallEndpoint(runtime.toolCallEndpoint);
    }

    createRuntimeInstance(config: ControlInstanceConfig): Instance {
        const instance = createInstance(config);
        instance.supervision.state.onChange(() => {
            // Only the registry's current generation may invalidate the list.
            if (this.#registry.get(instance.config.name) === instance)
                this.changes.publish("registry");
        });
        if (this.#toolCallEndpoint !== undefined)
            instance.attachToolCallEndpoint(this.#toolCallEndpoint);
        return instance;
    }

    async reconcile(signal?: AbortSignal): Promise<void> {
        const editor = this.#editor;
        if (editor === undefined || signal?.aborted) return;
        // Independent debts are reconciled in bounded parallel batches.
        // One unreachable old Worker must not hold sibling retirements
        // or Control readiness hostage. A stopping Control never starts
        // additional batches, while in-flight operations remain generation-
        // fenced by InstanceCleanupDebt.
        const pending = (await editor.listCleanupDebts())
            .filter((record) => record.state === "pending");
        const BATCH_SIZE = 4;
        for (let index = 0; index < pending.length; index += BATCH_SIZE) {
            if (signal?.aborted) return;
            await Promise.allSettled(
                pending.slice(index, index + BATCH_SIZE).map(async (record) => {
                    if (signal?.aborted) return;
                    try {
                        await editor.reconcileCleanupDebt(record.instance);
                    } catch (error) {
                        console.warn(
                            "Instance cleanup debt reconciliation deferred:",
                            record.instance,
                            error,
                        );
                    }
                }),
            );
        }
    }

    connectionClosed(connectionId: string): void {
        for (const instance of this.#registry.list())
            instance.connectionClosed(connectionId);
    }

    async load(config: ControlConfig): Promise<void> {
        const created: Instance[] = [];
        try {
            for (const definition of config.instances) {
                if (!definition.enabled) continue;
                try {
                    created.push(this.createRuntimeInstance(definition));
                } catch (error) {
                    console.warn(`Instance ${definition.name} is unavailable; others remain active:`, error);
                }
            }
            this.#registry = new InstanceRegistry(created);
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            for (const instance of created)
                await instance.close().catch((cleanupError) =>
                    cleanupFailures.push(cleanupError),
                );
            this.reset();
            if (cleanupFailures.length > 0) {
                throw new AggregateError(
                    [error, ...cleanupFailures],
                    "Control instance load failed and cleanup was incomplete.",
                );
            }
            throw error;
        }
    }

    async close(): Promise<void> {
        const failures: unknown[] = [];
        try {
            this.#reverseConnections?.stop();
        } catch (error) {
            failures.push(error);
        }
        for (const instance of this.#registry.list()) {
            await instance.close().catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                `Failed to close ${failures.length} instance resource(s).`,
            );
        }
    }

    reset(): void {
        this.#editor = undefined;
        this.#registry = new InstanceRegistry([]);
        this.#reverseConnections = undefined;
        this.#toolCallEndpoint = undefined;
    }
}
