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
    // ControlInstances survives Control.stop()/restart(); recovery fences must
    // survive registry reset to prevent a stale Hook from retiring a new peer.
    readonly #recoveringNames = new Map<
        string,
        { task: Promise<void>; editor: InstanceEditorCoordinator }
    >();
    readonly #quarantinedNames = new Set<string>();
    #onRecoveryFenceCleared?: () => void;

    onRecoveryFenceCleared(callback: () => void): void {
        this.#onRecoveryFenceCleared = callback;
    }

    isRecovering(name: string): boolean {
        const recovery = this.#recoveringNames.get(name);
        return recovery !== undefined && recovery.editor !== this.#editor;
    }

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
        const pending = (await editor.listCleanupDebts())
            .filter((record) => record.state === "pending");
        let cursor = 0;
        const workers = Array.from(
            { length: Math.min(4, pending.length) },
            async () => {
                // Refill a completed slot immediately, independently of a
                // sibling SSH provider that remains unreachable.
                while (!signal?.aborted) {
                    const record = pending[cursor++];
                    if (record === undefined) return;
                    const name = record.instance;
                    if (this.#recoveringNames.has(name)) continue;
                    const run = editor.reconcileCleanupDebt(name);
                    this.#recoveringNames.set(name, { task: run, editor });
                    try {
                        await run;
                    } catch (error) {
                        console.warn(
                            "Instance cleanup debt reconciliation deferred:",
                            name,
                            error,
                        );
                    } finally {
                        if (this.#recoveringNames.get(name)?.task === run)
                            this.#recoveringNames.delete(name);
                        if (this.#quarantinedNames.delete(name)) {
                            // Do not instantiate from a stale editor snapshot.
                            // A new Control start reloads durable debt state.
                            this.#onRecoveryFenceCleared?.();
                        }
                    }
                }
            },
        );
        await Promise.allSettled(workers);
    }

    connectionClosed(connectionId: string): void {
        for (const instance of this.#registry.list())
            instance.connectionClosed(connectionId);
    }

    async load(config: ControlConfig): Promise<void> {
        const created: Instance[] = [];
        this.#quarantinedNames.clear();
        try {
            for (const definition of config.instances) {
                if (!definition.enabled) continue;
                if (this.#recoveringNames.has(definition.name)) {
                    this.#quarantinedNames.add(definition.name);
                    console.warn(
                        "Instance " + definition.name + " is deferred: previous Control lifecycle cleanup is still running.",
                    );
                    continue;
                }
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
        this.#quarantinedNames.clear();
        this.#editor = undefined;
        this.#registry = new InstanceRegistry([]);
        this.#reverseConnections = undefined;
        this.#toolCallEndpoint = undefined;
    }
}
