import {
    createRemoteError,
    runtimeErrorCodes,
    type InstanceSnapshot,
} from "@portable-devshell/shared";

import type { WorkerInstanceLifecycle } from "../execution/Lifecycle.js";
import type { WorkerInstanceSupervision } from "./Recovery.js";

interface WorkerOwnershipOptions {
    admission: {
        active(): boolean;
        enabled(): boolean;
    };
    instanceName: string;
    lifecycle: WorkerInstanceLifecycle;
    managementMode: "controllerManaged" | "selfManaged";
    recovery: WorkerInstanceSupervision;
    snapshot(): InstanceSnapshot;
}

export class WorkerOwnership {
    #autoOwned = false;
    #explicitlyOwned = false;
    readonly #references = new Set<string>();

    constructor(private readonly options: WorkerOwnershipOptions) {}

    get owned(): boolean {
        return this.#explicitlyOwned || this.#autoOwned;
    }

    async acquireReference(reference: string): Promise<InstanceSnapshot> {
        if (!this.options.admission.enabled()) {
            throw createRemoteError({
                code: runtimeErrorCodes.instanceConflict,
                details: {
                    instance: this.options.instanceName,
                    operation: "connect",
                },
                message: `Instance ${this.options.instanceName} is disabled.`,
                retryable: false,
            });
        }

        let snapshot = this.options.snapshot();
        let started = false;
        if (!snapshot.ready) {
            if (this.options.managementMode === "selfManaged") {
                snapshot = await this.options.recovery.refreshStatus();
                if (!snapshot.ready) {
                    throw createRemoteError({
                        code: runtimeErrorCodes.reverseSelfManagedOffline,
                        details: { instance: this.options.instanceName },
                        message: `Instance ${this.options.instanceName} is self-managed and is not connected.`,
                        retryable: true,
                    });
                }
            } else {
                snapshot = await this.options.lifecycle.start();
                started = true;
            }
        }

        if (!this.options.admission.active()) {
            if (
                started &&
                this.options.snapshot().daemonState !== "stopped"
            ) {
                await this.options.lifecycle.stop();
            }
            throw createRemoteError({
                code: runtimeErrorCodes.instanceConflict,
                details: {
                    instance: this.options.instanceName,
                    operation: "connect",
                },
                message: `Instance ${this.options.instanceName} generation was retired while connecting.`,
                retryable: true,
            });
        }

        if (this.options.managementMode !== "selfManaged") {
            this.#references.add(reference);
            if (started) this.#autoOwned = true;
        }
        return snapshot;
    }

    async releaseReference(reference: string): Promise<void> {
        if (!this.#references.delete(reference)) return;
        if (
            this.#references.size > 0 ||
            !this.#autoOwned ||
            this.#explicitlyOwned
        ) {
            return;
        }
        if (this.options.snapshot().daemonState !== "stopped")
            await this.options.lifecycle.stop();
        this.#autoOwned = false;
    }

    markOwned(): void {
        this.#explicitlyOwned = true;
    }

    clearOwned(): void {
        this.#explicitlyOwned = false;
        this.#autoOwned = false;
        this.#references.clear();
    }
}
