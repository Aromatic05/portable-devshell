import {
    createRemoteError,
    runtimeErrorCodes,
    type ControlInstanceConfig,
    type ControlMcpContextMode,
} from "@portable-devshell/shared";

import type { ApprovalApi } from "../approval/Api.js";
import type { TerminalBackend } from "../terminal/Backend.js";
import type { WorkerInstance } from "./runtime/index.js";
import type { TransportConnection } from "./transport/endpoint/Connection.js";

export interface InstanceLease {
    readonly instance: Instance;
    release(): void;
}

export interface InstanceReferenceLease {
    snapshot: ReturnType<WorkerInstance["snapshot"]>;
    worker: WorkerInstance;
}

export interface InstanceFields {
    approval: ApprovalApi;
    enabled: boolean;
    mcpContextMode?: ControlMcpContextMode;
    mcpEnabled: boolean;
    mcpPath: string;
    modelExtensions: readonly string[];
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnection?: TransportConnection;
    terminal: TerminalBackend;
    worker: WorkerInstance;
}

export class Instance {
    readonly #approval: ApprovalApi;
    readonly #name: string;
    readonly #provider: InstanceFields["provider"];
    readonly #reverseConnection?: TransportConnection;
    readonly #terminal: TerminalBackend;
    readonly #worker: WorkerInstance;
    #enabled: boolean;
    #mcpContextMode?: ControlMcpContextMode;
    #mcpEnabled: boolean;
    #mcpPath: string;
    #modelExtensions: readonly string[];
    #admitted = 0;
    #owned = false;
    readonly #ownedWorkers = new Set<WorkerInstance>();
    readonly #references = new Map<WorkerInstance, Set<string>>();
    #retired = false;
    readonly #waiters = new Set<() => void>();

    constructor(fields: InstanceFields) {
        this.#approval = fields.approval;
        this.#enabled = fields.enabled;
        this.#mcpContextMode = fields.mcpContextMode;
        this.#mcpEnabled = fields.mcpEnabled;
        this.#mcpPath = fields.mcpPath;
        this.#modelExtensions = fields.modelExtensions;
        this.#name = fields.name;
        this.#provider = fields.provider;
        this.#reverseConnection = fields.reverseConnection;
        this.#terminal = fields.terminal;
        this.#worker = fields.worker;
    }

    get approval(): ApprovalApi {
        return this.#approval;
    }

    get enabled(): boolean {
        return this.#enabled;
    }

    get mcpContextMode(): ControlMcpContextMode | undefined {
        return this.#mcpContextMode;
    }

    get mcpEnabled(): boolean {
        return this.#mcpEnabled;
    }

    get mcpPath(): string {
        return this.#mcpPath;
    }

    get modelExtensions(): readonly string[] {
        return this.#modelExtensions;
    }

    get name(): string {
        return this.#name;
    }

    get provider(): InstanceFields["provider"] {
        return this.#provider;
    }

    get reverseConnection(): TransportConnection | undefined {
        return this.#reverseConnection;
    }

    get terminal(): TerminalBackend {
        return this.#terminal;
    }

    get worker(): WorkerInstance {
        return this.#worker;
    }

    get owned(): boolean {
        return this.#owned;
    }

    get retired(): boolean {
        return this.#retired;
    }

    update(instance: ControlInstanceConfig): void {
        this.#enabled = instance.enabled;
        this.#mcpContextMode = instance.mcp.contextMode;
        this.#mcpEnabled = instance.mcp.enabled;
        this.#mcpPath = instance.mcp.path;
        this.#modelExtensions = [...instance.extensions.model];
    }

    acquireLease(): InstanceLease {
        if (this.#retired) {
            throw new Error(`Instance generation ${this.#name} is retired.`);
        }
        this.#admitted += 1;
        let released = false;
        return {
            instance: this,
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

    async retire(): Promise<void> {
        this.#retired = true;
        if (this.#admitted > 0) {
            await new Promise<void>((resolve) => {
                if (this.#admitted === 0) resolve();
                else this.#waiters.add(resolve);
            });
        }
    }

    async acquireReference(reference: string): Promise<InstanceReferenceLease> {
        if (!this.#enabled) {
            throw createRemoteError({
                code: runtimeErrorCodes.instanceConflict,
                details: { instance: this.#name, operation: "connect" },
                message: `Instance ${this.#name} is disabled.`,
                retryable: false,
            });
        }

        const lease = this.acquireLease();
        try {
            let snapshot = this.#worker.snapshot();
            let ownsLifecycle = false;
            if (!snapshot.ready) {
                if (this.#worker.managementMode === "selfManaged") {
                    snapshot = await this.#worker.refreshStatus();
                    if (!snapshot.ready) {
                        throw createRemoteError({
                            code: runtimeErrorCodes.reverseSelfManagedOffline,
                            details: { instance: this.#name },
                            message: `Instance ${this.#name} is self-managed and is not connected.`,
                            retryable: true,
                        });
                    }
                } else {
                    snapshot = await this.#worker.start();
                    ownsLifecycle = true;
                }
            }

            if (this.#retired) {
                if (
                    ownsLifecycle &&
                    this.#worker.snapshot().daemonState !== "stopped"
                ) {
                    await this.#worker.stop();
                }
                throw createRemoteError({
                    code: runtimeErrorCodes.instanceConflict,
                    details: { instance: this.#name, operation: "connect" },
                    message: `Instance ${this.#name} generation was retired while connecting.`,
                    retryable: true,
                });
            }

            if (this.#worker.managementMode !== "selfManaged") {
                this.#retainReference(reference, ownsLifecycle);
            }
            return { snapshot, worker: this.#worker };
        } finally {
            lease.release();
        }
    }

    async releaseReference(reference: string): Promise<void> {
        const released = this.#releaseReference(reference);
        if (released === undefined || !released.shouldStop) return;
        const { worker } = released;
        if (worker.snapshot().daemonState !== "stopped") {
            await worker.stop();
        }
        this.#ownedWorkers.delete(worker);
    }

    markOwned(): void {
        this.#owned = true;
    }

    clearOwned(): void {
        this.#owned = false;
        this.#ownedWorkers.clear();
        this.#references.clear();
    }

    ownedWorkers(): readonly WorkerInstance[] {
        const workers = new Set<WorkerInstance>(this.#ownedWorkers);
        if (this.#owned) workers.add(this.#worker);
        return [...workers];
    }

    clearOwnedWorker(worker: WorkerInstance): void {
        if (this.#owned && worker === this.#worker) this.#owned = false;
        this.#ownedWorkers.delete(worker);
    }

    async close(): Promise<void> {
        await this.#worker.close();
    }

    #retainReference(reference: string, ownsLifecycle: boolean): void {
        for (const [candidate, references] of this.#references) {
            if (candidate !== this.#worker && references.has(reference)) {
                throw new Error(
                    `Connection reference ${reference} is already bound to another Worker generation for ${this.#name}.`,
                );
            }
        }
        const references = this.#references.get(this.#worker) ?? new Set<string>();
        references.add(reference);
        this.#references.set(this.#worker, references);
        if (ownsLifecycle) this.#ownedWorkers.add(this.#worker);
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
                `Connection reference ${reference} is ambiguous for instance ${this.#name}.`,
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
