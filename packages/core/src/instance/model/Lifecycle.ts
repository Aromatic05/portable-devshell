import { createRemoteError, runtimeErrorCodes } from "@portable-devshell/shared";

import type { WorkerInstance } from "../runtime/Api.js";
import type { Instance } from "./Instance.js";

export interface InstanceLease {
    readonly instance: Instance;
    release(): void;
}

export interface InstanceReferenceLease {
    snapshot: ReturnType<WorkerInstance["supervision"]["snapshot"]>;
    worker: WorkerInstance;
}

export class InstanceLifecycle {
    #admitted = 0;
    #owned = false;
    readonly #ownedWorkers = new Set<WorkerInstance>();
    readonly #references = new Map<WorkerInstance, Set<string>>();
    #retired = false;
    #retirementPromise?: Promise<void>;
    readonly #waiters = new Set<() => void>();

    constructor(
        private readonly instance: Instance,
        private readonly worker: WorkerInstance,
    ) {}

    get owned(): boolean {
        return this.#owned;
    }

    get retired(): boolean {
        return this.#retired;
    }

    acquireLease(): InstanceLease {
        if (this.#retired) {
            throw new Error(`Instance generation ${this.instance.config.name} is retired.`);
        }
        this.#admitted += 1;
        let released = false;
        return {
            instance: this.instance,
            release: () => {
                if (released) return;
                released = true;
                this.#admitted -= 1;
                if (this.#admitted !== 0) return;
                for (const waiter of this.#waiters) waiter();
                this.#waiters.clear();
            },
        };
    }

    retire(beforeDrain?: () => Promise<void>): Promise<void> {
        if (this.#retirementPromise !== undefined) return this.#retirementPromise;
        this.#retired = true;
        this.#retirementPromise = Promise.resolve().then(
            async () => await this.#retire(beforeDrain),
        );
        const retirement = this.#retirementPromise;
        void retirement.catch(() => {
            if (this.#retirementPromise === retirement)
                this.#retirementPromise = undefined;
        });
        return retirement;
    }

    async acquireReference(reference: string): Promise<InstanceReferenceLease> {
        if (!this.instance.config.enabled) {
            throw createRemoteError({
                code: runtimeErrorCodes.instanceConflict,
                details: { instance: this.instance.config.name, operation: "connect" },
                message: `Instance ${this.instance.config.name} is disabled.`,
                retryable: false,
            });
        }

        const lease = this.acquireLease();
        try {
            let snapshot = this.worker.supervision.snapshot();
            let ownsLifecycle = false;
            if (!snapshot.ready) {
                if (this.worker.supervision.managementMode === "selfManaged") {
                    snapshot = await this.worker.supervision.recovery.refreshStatus();
                    if (!snapshot.ready) {
                        throw createRemoteError({
                            code: runtimeErrorCodes.reverseSelfManagedOffline,
                            details: { instance: this.instance.config.name },
                            message: `Instance ${this.instance.config.name} is self-managed and is not connected.`,
                            retryable: true,
                        });
                    }
                } else {
                    snapshot = await this.worker.supervision.lifecycle.start();
                    ownsLifecycle = true;
                }
            }

            if (this.#retired) {
                if (
                    ownsLifecycle &&
                    this.worker.supervision.snapshot().daemonState !== "stopped"
                ) {
                    await this.worker.supervision.lifecycle.stop();
                }
                throw createRemoteError({
                    code: runtimeErrorCodes.instanceConflict,
                    details: { instance: this.instance.config.name, operation: "connect" },
                    message: `Instance ${this.instance.config.name} generation was retired while connecting.`,
                    retryable: true,
                });
            }

            if (this.worker.supervision.managementMode !== "selfManaged")
                this.#retainReference(reference, ownsLifecycle);
            return { snapshot, worker: this.worker };
        } finally {
            lease.release();
        }
    }

    async releaseReference(reference: string): Promise<void> {
        const released = this.#releaseReference(reference);
        if (released === undefined || !released.shouldStop) return;
        if (released.worker.supervision.snapshot().daemonState !== "stopped")
            await released.worker.supervision.lifecycle.stop();
        this.#ownedWorkers.delete(released.worker);
    }

    markOwned(): void { this.#owned = true; }

    clearOwned(): void {
        this.#owned = false;
        this.#ownedWorkers.clear();
        this.#references.clear();
    }

    ownedWorkers(): readonly WorkerInstance[] {
        const workers = new Set<WorkerInstance>(this.#ownedWorkers);
        if (this.#owned) workers.add(this.worker);
        return [...workers];
    }

    clearOwnedWorker(worker: WorkerInstance): void {
        if (this.#owned && worker === this.worker) this.#owned = false;
        this.#ownedWorkers.delete(worker);
    }

    async #retire(beforeDrain?: () => Promise<void>): Promise<void> {
        let retirementFailure: unknown;
        try {
            await beforeDrain?.();
        } catch (error) {
            retirementFailure = error;
        }
        if (this.#admitted > 0) {
            await new Promise<void>((resolve) => {
                if (this.#admitted === 0) resolve();
                else this.#waiters.add(resolve);
            });
        }
        if (retirementFailure !== undefined) throw retirementFailure;
    }

    #retainReference(reference: string, ownsLifecycle: boolean): void {
        for (const [candidate, references] of this.#references) {
            if (candidate !== this.worker && references.has(reference)) {
                throw new Error(
                    `Connection reference ${reference} is already bound to another Worker generation for ${this.instance.config.name}.`,
                );
            }
        }
        const references = this.#references.get(this.worker) ?? new Set<string>();
        references.add(reference);
        this.#references.set(this.worker, references);
        if (ownsLifecycle) this.#ownedWorkers.add(this.worker);
    }

    #releaseReference(
        reference: string,
    ): { shouldStop: boolean; worker: WorkerInstance } | undefined {
        const matched = [...this.#references.entries()].filter(
            ([, references]) => references.has(reference),
        );
        if (matched.length === 0) return undefined;
        if (matched.length > 1) {
            throw new Error(
                `Connection reference ${reference} is ambiguous for instance ${this.instance.config.name}.`,
            );
        }
        const [worker, references] = matched[0]!;
        references.delete(reference);
        if (references.size > 0) return { shouldStop: false, worker };
        this.#references.delete(worker);
        return {
            shouldStop: this.#ownedWorkers.has(worker) && !this.#owned,
            worker,
        };
    }
}
