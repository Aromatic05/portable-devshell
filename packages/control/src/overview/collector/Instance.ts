import {
    asInstanceName,
    createApprovalTransport,
    createProcessTransport,
    createToolTransport,
    type Endpoint,
    type OperationalOverviewActivity,
    type OperationalOverviewAlert,
    type OperationalOverviewInstance,
} from "@portable-devshell/shared";
import type { Instance } from "@portable-devshell/core";
import {
    createCollectionFailure,
    createRecentFailureAlert,
    createSnapshotAlerts,
    selectOperationalActivity,
} from "./Policy.js";

export interface OperationalOverviewInstanceCollection {
    activity: OperationalOverviewActivity[];
    alerts: OperationalOverviewAlert[];
    failedCalls24h: number;
    instance: OperationalOverviewInstance;
}

export class OperationalOverviewInstanceCollector {
    constructor(
        readonly options: {
            activityLimit: number;
            endpoint: Endpoint;
        },
    ) {}

    async collect(
        descriptor: Instance,
        now: Date,
    ): Promise<OperationalOverviewInstanceCollection> {
        const name = asInstanceName(descriptor.config.name);
        const alerts: OperationalOverviewAlert[] = [];
        const read = async <T>(
            subject: string,
            operation: () => T | Promise<T>,
            failed: T,
        ): Promise<T> => {
            try {
                return await operation();
            } catch (error) {
                alerts.push(createCollectionFailure(name, subject, error));
                return failed;
            }
        };
        const process = createProcessTransport(this.options.endpoint, name);
        const approval = createApprovalTransport(this.options.endpoint, name);
        const tools = createToolTransport(this.options.endpoint, name);
        const snapshotEnvelope = await read(
            "snapshot",
            () => process.snapshot(),
            {
                lastSeq: 0,
                snapshot: {
                    connectionState: "failed",
                    daemonState: "failed",
                    lastSeq: 0,
                    name,
                    ready: false,
                    status: "failed",
                },
            },
        );
        const snapshot = snapshotEnvelope.snapshot;
        alerts.push(...createSnapshotAlerts(name, snapshot));
        const [pending, records, failure] = await Promise.all([
            read("approvals", () => approval.list({ pendingOnly: true }), []),
            read(
                "activity",
                () =>
                    tools.listCalls({
                        includeInput: false,
                        includeOutput: false,
                        limit: this.options.activityLimit,
                        maxBytes: 128 * 1024,
                    }),
                [],
            ),
            read(
                "tool failures",
                () =>
                    tools.readFailureSummary(
                        now.getTime() - 24 * 60 * 60 * 1000,
                        now.getTime(),
                    ),
                { count: 0 },
            ),
        ]);
        if (pending.length > 0)
            alerts.push({
                id: `approval.pending:${name}`,
                instance: name,
                kind: "approval.pending",
                severity: "attention",
                title: "Approval required",
                detail: `${pending.length} approval requests waiting.`,
            });
        const recent = createRecentFailureAlert(name, failure);
        if (recent.alert !== undefined) alerts.push(recent.alert);
        return {
            activity: selectOperationalActivity(records, this.options.activityLimit),
            alerts,
            failedCalls24h: recent.count,
            instance: {
                mcpEnabled: descriptor.config.mcpEnabled,
                name,
                pendingApprovals: pending.length,
                provider: descriptor.config.provider,
                snapshot,
                ...(snapshotEnvelope.worker === undefined
                    ? {}
                    : { worker: snapshotEnvelope.worker }),
            },
        };
    }
}
