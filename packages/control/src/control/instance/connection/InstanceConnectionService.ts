import type { WorkerHandle } from "@portable-devshell/core";
import { createError, errorCodes } from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../InstanceDescriptor.js";
import type { InstanceRegistry } from "../registry/InstanceRegistry.js";

export interface InstanceConnectionLease {
    handle: WorkerHandle;
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

    async acquire(instance: string, reference: string): Promise<InstanceConnectionLease> {
        const descriptor = this.#requireDescriptor(instance);
        if (!descriptor.enabled) {
            throw createError({
                code: errorCodes.instanceConflict,
                details: { instance, operation: "connect" },
                message: `Instance ${instance} is disabled.`,
                retryable: false
            });
        }

        let snapshot = descriptor.worker.snapshot();
        let ownsLifecycle = false;
        if (!snapshot.ready) {
            if (descriptor.worker.managementMode === "selfManaged") {
                snapshot = await descriptor.worker.refreshStatus();
                if (!snapshot.ready) {
                    throw createError({
                        code: errorCodes.reverseSelfManagedOffline,
                        details: { instance },
                        message: `Instance ${instance} is self-managed and is not connected.`,
                        retryable: true
                    });
                }
            } else {
                snapshot = await descriptor.worker.start();
                ownsLifecycle = true;
            }
        }

        if (descriptor.worker.managementMode !== "selfManaged") {
            this.#registry.retainConnectionReference(instance, reference, ownsLifecycle);
        }
        return {
            handle: descriptor.worker.handle,
            snapshot,
            worker: descriptor.worker
        };
    }

    async release(instance: string, reference: string): Promise<void> {
        const descriptor = this.#requireDescriptor(instance);
        if (descriptor.worker.managementMode === "selfManaged") return;
        if (!this.#registry.releaseConnectionReference(instance, reference)) return;
        if (descriptor.worker.snapshot().daemonState !== "stopped") {
            await descriptor.worker.stop();
        }
        this.#registry.clearConnectionOwnership(instance);
    }

    #requireDescriptor(instance: string): InstanceDescriptor {
        const descriptor = this.#registry.get(instance);
        if (descriptor !== undefined) return descriptor;
        throw createError({
            code: errorCodes.instanceMissing,
            details: { instance },
            message: `Instance ${instance} was not found.`,
            retryable: false
        });
    }
}
