import type {
    OperationalOverviewActivity,
    OperationalOverviewAlert,
    OperationalOverviewInstance,
    OperationalOverviewTodo
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../instance/InstanceDescriptor.js";
import {
    createCollectionFailure,
    createRecentFailureAlert,
    createSnapshotAlerts,
    createTodoAlerts,
    toOperationalActivity
} from "./OperationalOverviewPolicy.js";

export interface OperationalOverviewInstanceCollection {
    activity: OperationalOverviewActivity[];
    alerts: OperationalOverviewAlert[];
    failedCalls24h: number;
    instance: OperationalOverviewInstance;
    todos: OperationalOverviewTodo[];
}

export class OperationalOverviewInstanceCollector {
    readonly #activityLimit: number;

    constructor(options?: { activityLimit?: number }) {
        this.#activityLimit = options?.activityLimit ?? 20;
    }

    async collect(
        descriptor: InstanceDescriptor,
        now: Date
    ): Promise<OperationalOverviewInstanceCollection> {
        const snapshot = descriptor.worker.snapshot();
        const alerts = createSnapshotAlerts(snapshot.name, snapshot);
        const todos = descriptor.todo.summaries().map((todo) => ({
            ...todo,
            instance: snapshot.name
        }));
        alerts.push(...createTodoAlerts(snapshot.name, todos));

        const [approvalsResult, callsResult] = await Promise.allSettled([
            descriptor.worker.listApprovals(),
            descriptor.worker.readToolCalls({ limit: this.#activityLimit })
        ]);
        const pendingApprovals = approvalsResult.status === "fulfilled"
            ? approvalsResult.value.length
            : 0;
        if (pendingApprovals > 0) {
            alerts.push({
                detail: `${pendingApprovals} tool call approval${pendingApprovals === 1 ? "" : "s"} waiting.`,
                id: `approval.pending:${descriptor.name}`,
                instance: snapshot.name,
                kind: "approval.pending",
                severity: "attention",
                title: "Tool approval required"
            });
        }
        if (approvalsResult.status === "rejected") {
            alerts.push(createCollectionFailure(
                snapshot.name,
                "tool approvals",
                approvalsResult.reason
            ));
        }

        const calls = callsResult.status === "fulfilled" ? callsResult.value : [];
        if (callsResult.status === "rejected") {
            alerts.push(createCollectionFailure(
                snapshot.name,
                "recent activity",
                callsResult.reason
            ));
        }
        const recentFailure = createRecentFailureAlert(snapshot.name, calls, now);
        if (recentFailure.alert !== undefined) {
            alerts.push(recentFailure.alert);
        }

        return {
            activity: calls.map(toOperationalActivity),
            alerts,
            failedCalls24h: recentFailure.count,
            instance: {
                mcpEnabled: descriptor.mcpEnabled,
                name: snapshot.name,
                pendingApprovals,
                provider: descriptor.provider,
                snapshot,
                ...(descriptor.workspace === undefined ? {} : { workspace: descriptor.workspace })
            },
            todos
        };
    }
}
