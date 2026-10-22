import type {
    OperationalOverview,
    OperationalOverviewAlert,
} from "@portable-devshell/shared";

import {
    OperationalOverviewSystemCollector,
    type OperationalOverviewSystemCollection,
} from "./collector/System.js";
import {
    createCollectionFailure,
    isAttentionSnapshot,
    isCriticalSnapshot,
    readOperationalHealth,
    sortOperationalAlerts,
} from "./collector/Policy.js";
import type {
    OperationalOverviewApprovalPort,
    OperationalOverviewInstanceCollectorPort,
    OperationalOverviewRegistryPort,
    OperationalOverviewRuntime,
    OperationalOverviewRuntimeOptions,
    OperationalOverviewSystemCollectorPort,
} from "./Api.js";

const activityLimit = 20;

export class OperationalOverviewService implements OperationalOverviewRuntime {
    #inFlight?: Promise<OperationalOverview>;
    readonly #instanceCollector: OperationalOverviewInstanceCollectorPort;
    readonly #instances: OperationalOverviewRegistryPort;
    readonly #now: () => Date;
    readonly #oauthApprovals: () => OperationalOverviewApprovalPort | undefined;
    readonly #processId: () => number;
    readonly #systemCollector: OperationalOverviewSystemCollectorPort;
    readonly #uptimeSeconds: () => number;

    constructor(options: OperationalOverviewRuntimeOptions) {
        this.#instanceCollector = options.instanceCollector;
        this.#instances = options.instances;
        this.#now = options.now ?? (() => new Date());
        this.#oauthApprovals = options.oauthApprovals ?? (() => undefined);
        this.#processId = options.processId ?? (() => process.pid);
        this.#systemCollector =
            options.systemCollector ?? new OperationalOverviewSystemCollector();
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
        const [collections, systemResult, oauthResult] = await Promise.all([
            Promise.all(
                this.#instances
                    .list()
                    .map(
                        async (descriptor) =>
                            await this.#instanceCollector.collect(
                                descriptor,
                                now,
                            ),
                    ),
            ),
            this.#collectSystem(),
            this.#collectOAuthApprovals(),
        ]);
        const alerts = collections.flatMap((collection) => collection.alerts);
        alerts.push(...systemResult.alerts);
        const instances = collections
            .map((collection) => collection.instance)
            .sort((left, right) => left.name.localeCompare(right.name));
        const activity = collections
            .flatMap((collection) => collection.activity)
            .sort((left, right) =>
                right.startedAt.localeCompare(left.startedAt),
            )
            .slice(0, activityLimit);
        let pendingApprovals = instances.reduce(
            (total, instance) => total + instance.pendingApprovals,
            0,
        );
        pendingApprovals += oauthResult.count;
        alerts.push(...oauthResult.alerts);
        sortOperationalAlerts(alerts);

        return {
            activity,
            alerts,
            controller: {
                pid: this.#processId(),
                ...(systemResult.system === undefined
                    ? {}
                    : { system: systemResult.system }),
                uptimeSeconds: Math.max(0, Math.floor(this.#uptimeSeconds())),
            },
            counts: {
                failedCalls24h: collections.reduce(
                    (total, collection) => total + collection.failedCalls24h,
                    0,
                ),
                instancesAttention: instances.filter((instance) =>
                    isAttentionSnapshot(instance.snapshot),
                ).length,
                instancesCritical: instances.filter((instance) =>
                    isCriticalSnapshot(instance.snapshot),
                ).length,
                instancesReady: instances.filter(
                    (instance) => instance.snapshot.ready,
                ).length,
                instancesTotal: instances.length,
                pendingApprovals,
            },
            generatedAt: now.toISOString(),
            health: readOperationalHealth(alerts),
            instances,
        };
    }

    async #collectSystem(): Promise<{
        alerts: OperationalOverviewAlert[];
        system?: OperationalOverviewSystemCollection["system"];
    }> {
        try {
            return await this.#systemCollector.collect();
        } catch (error) {
            return {
                alerts: [
                    createCollectionFailure(
                        undefined,
                        "controller resources",
                        error,
                    ),
                ],
            };
        }
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
            const pending = (await approvals.list()).filter(
                (approval) => approval.status === "pending",
            );
            if (pending.length === 0) {
                return { alerts: [], count: 0 };
            }
            return {
                alerts: [
                    {
                        detail: `${pending.length} OAuth approval${pending.length === 1 ? "" : "s"} waiting.`,
                        id: "approval.oauthPending",
                        kind: "approval.oauthPending",
                        severity: "attention",
                        title: "OAuth approval required",
                    },
                ],
                count: pending.length,
            };
        } catch (error) {
            return {
                alerts: [
                    createCollectionFailure(
                        undefined,
                        "OAuth approvals",
                        error,
                    ),
                ],
                count: 0,
            };
        }
    }
}
