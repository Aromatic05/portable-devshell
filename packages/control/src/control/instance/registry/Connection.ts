import { createError, errorCodes } from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../Descriptor.js";
import type { InstanceRegistry } from "./Registry.js";

export interface InstanceConnectionLease {
    snapshot: ReturnType<InstanceDescriptor["worker"]["snapshot"]>;
    worker: InstanceDescriptor["worker"];
}

/**
 * Shared lifecycle boundary for consumers of one managed Worker instance.
 *
 * MCP, Extensions and future consumers acquire the same WorkerInstance connection
 * by reference. Provider transport details and reverse inbound endpoints remain
 * encapsulated below WorkerInstance.
 */
export class InstanceConnectionService {
    readonly #registry: InstanceRegistry;

    constructor(registry: InstanceRegistry) {
        this.#registry = registry;
    }

    async acquire(
        instance: string,
        reference: string,
    ): Promise<InstanceConnectionLease> {
        const generation = this.#registry.acquireGeneration(instance);
        const descriptor = generation.descriptor;
        if (!descriptor.enabled) {
            generation.release();
            throw createError({
                code: errorCodes.instanceConflict,
                details: { instance, operation: "connect" },
                message: `Instance ${instance} is disabled.`,
                retryable: false,
            });
        }

        let ownsLifecycle = false;
        try {
            let snapshot = descriptor.worker.snapshot();
            if (!snapshot.ready) {
                if (descriptor.worker.managementMode === "selfManaged") {
                    snapshot = await descriptor.worker.refreshStatus();
                    if (!snapshot.ready) {
                        throw createError({
                            code: errorCodes.reverseSelfManagedOffline,
                            details: { instance },
                            message: `Instance ${instance} is self-managed and is not connected.`,
                            retryable: true,
                        });
                    }
                } else {
                    snapshot = await descriptor.worker.start();
                    ownsLifecycle = true;
                }
            }

            if (this.#registry.get(instance) !== descriptor) {
                if (
                    ownsLifecycle &&
                    descriptor.worker.snapshot().daemonState !== "stopped"
                ) {
                    await descriptor.worker.stop();
                }
                throw createError({
                    code: errorCodes.instanceConflict,
                    details: { instance, operation: "connect" },
                    message: `Instance ${instance} generation was retired while connecting.`,
                    retryable: true,
                });
            }

            if (descriptor.worker.managementMode !== "selfManaged") {
                this.#registry.retainConnectionReference(
                    instance,
                    descriptor.worker,
                    reference,
                    ownsLifecycle,
                );
            }
            return {
                snapshot,
                worker: descriptor.worker,
            };
        } finally {
            generation.release();
        }
    }

    async release(instance: string, reference: string): Promise<void> {
        const released = this.#registry.releaseConnectionReference(
            instance,
            reference,
        );
        if (released === undefined || !released.shouldStop) return;
        const { worker } = released;
        if (worker.snapshot().daemonState !== "stopped") {
            await worker.stop();
        }
        this.#registry.clearConnectionOwnership(instance, worker);
    }

}
