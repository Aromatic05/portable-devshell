import type {
    OperationalOverview,
    OperationalOverviewAlert
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../instance/InstanceDescriptor.js";
import {
    OperationalOverviewInstanceCollector,
    type OperationalOverviewInstanceCollection
} from "./OperationalOverviewInstanceCollector.js";
import {
    createCollectionFailure,
    isCriticalSnapshot,
    readOperationalHealth,
    sortOperationalAlerts
} from "./OperationalOverviewPolicy.js";

const activityLimit = 20;

export interface OperationalOverviewRegistryPort {
    list(): readonly InstanceDescriptor[];
}

export interface OperationalOverviewApprovalPort {
    list(): Promise<readonly unknown[]>;
}

export interface OperationalOverviewInstanceCollectorPort {
    collect(
        descriptor: InstanceDescriptor,
        now: Date
    ): Promise<OperationalOverviewInstanceCollection>;
}

export interface OperationalOverviewServiceOptions {
    instanceCollector?: OperationalOverviewInstanceCollectorPort;
    instances: OperationalOverviewRegistryPort;
    now?: () => Date;
    oauthApprovals?: () => OperationalOverviewApprovalPort | undefined;
    processId?: () => number;
    uptimeSeconds?: () => number;
}

export class OperationalOverviewService {
    #inFlight?: Promise<OperationalOverview>;
    readonly #instanceCollector: OperationalOverviewInstanceCollectorPort;
    readonly #instances: OperationalOverviewRegistryPort;
    readonly #now: () => Date;
    readonly #oauthApprovals: () => OperationalOverviewApprovalPort | undefined;
    readonly #processId: () => number;
    readonly #uptimeSeconds: () => number;

    constructor(options: OperationalOverviewServiceOptions) {
        this.#instanceCollector = options.instanceCollector ??
            new OperationalOverviewInstanceCollector({ activityLimit });
        this.#instances = options.instances;
        this.#now = options.now ?? (() => new Date());
        this.#oauthApprovals = options.oauthApprovals ?? (() => undefined);
        this.#processId = options.processId ?? (() => process.pid);
        this.#uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
    }

    async read(): Promise<OperationalOverview> {
        if (this.#inFlight !== undefined) {
            return await this.#inFlight;
        }
        const request = this.#collect();
        this.#inFlight = request;
        try {
            return await request;
        } finally {
            if (this.#inFlight === request) {
                this.#inFlight = undefined;
            }
        }
    }

    async #collect(): Promise<OperationalOverview> {
        const now = this.#now();
        const collections = await Promise.all(
            this.#instances.list().map(async (descriptor) =>
                await this.#instanceCollector.collect(descriptor, now)
            )
        );
        const alerts = collections.flatMap((collection) => collection.alerts);
        const instances = collections
            .map((collection) => collection.instance)
            .sort((left, right) => left.name.localeCompare(right.name));
        const todos = collections
            .flatMap((collection) => collection.todos)
            .sort((left, right) => left.title.localeCompare(right.title));
        const activity = collections
            .flatMap((collection) => collection.activity)
            .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
            .slice(0, activityLimit);
        let pendingApprovals = instances.reduce(
            (total, instance) => total + instance.pendingApprovals,
            0
        );
        const oauthResult = await this.#collectOAuthApprovals();
        pendingApprovals += oauthResult.count;
        alerts.push(...oauthResult.alerts);
        sortOperationalAlerts(alerts);

        return {
            activity,
            alerts,
            controller: {
                pid: this.#processId(),
                uptimeSeconds: Math.max(0, Math.floor(this.#uptimeSeconds()))
            },
            counts: {
                activeTodos: todos.length,
                failedCalls24h: collections.reduce(
                    (total, collection) => total + collection.failedCalls24h,
                    0
                ),
                instancesAttention: instances.filter(
                    (instance) => !isCriticalSnapshot(instance.snapshot) && !instance.snapshot.ready
                ).length,
                instancesCritical: instances.filter(
                    (instance) => isCriticalSnapshot(instance.snapshot)
                ).length,
                instancesReady: instances.filter((instance) => instance.snapshot.ready).length,
                instancesTotal: instances.length,
                pendingApprovals
            },
            generatedAt: now.toISOString(),
            health: readOperationalHealth(alerts),
            instances,
            todos
        };
    }

    async #collectOAuthApprovals(): Promise<{
        alerts: OperationalOverviewAlert[];
        count: number;
    }> {
        const approvals = this.#oauthApprovals();
        if (approvals === undefined) {
            return { alerts: [], count: 0 };
        }
        try {
            const pending = await approvals.list();
            if (pending.length === 0) {
                return { alerts: [], count: 0 };
            }
            return {
                alerts: [{
                    detail: `${pending.length} OAuth approval${pending.length === 1 ? "" : "s"} waiting.`,
                    id: "approval.oauthPending",
                    kind: "approval.oauthPending",
                    severity: "attention",
                    title: "OAuth approval required"
                }],
                count: pending.length
            };
        } catch (error) {
            return {
                alerts: [createCollectionFailure(undefined, "OAuth approvals", error)],
                count: 0
            };
        }
    }
}
