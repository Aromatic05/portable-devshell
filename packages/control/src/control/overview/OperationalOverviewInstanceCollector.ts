import {
    asInstanceName,
    type InstanceSnapshot,
    OperationalOverviewActivity,
    OperationalOverviewAlert,
    OperationalOverviewInstance,
    OperationalOverviewTodo,
    type OperationalOverviewWorker
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../instance/InstanceDescriptor.js";
import {
    createCollectionFailure,
    createRecentFailureAlert,
    createSnapshotAlerts,
    createTodoAlerts,
    selectOperationalActivity
} from "./OperationalOverviewPolicy.js";

const failureWindowMs = 24 * 60 * 60 * 1_000;

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
        const snapshot = readSnapshot(descriptor);
        const alerts = createSnapshotAlerts(snapshot.name, snapshot);
        let todos: OperationalOverviewTodo[] = [];
        try {
            todos = descriptor.todo.summaries().map((todo) => ({
                ...todo,
                instance: snapshot.name
            }));
        } catch (error) {
            alerts.push(createCollectionFailure(snapshot.name, "todo summaries", error));
        }
        alerts.push(...createTodoAlerts(snapshot.name, todos));

        const [approvalsResult, callsResult, failureResult] = await Promise.allSettled([
            descriptor.worker.listPendingApprovals(),
            descriptor.worker.readToolCalls({ limit: Math.max(1, this.#activityLimit) }),
            descriptor.worker.readToolCallFailureSummary(
                now.getTime() - failureWindowMs,
                now.getTime(),
            ),
        ]);
        const pendingApprovals = approvalsResult.status === "fulfilled" ? approvalsResult.value.length : 0;
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
        const toolCallFailure = callsResult.status === "rejected"
            ? callsResult.reason
            : failureResult.status === "rejected"
              ? failureResult.reason
              : undefined;
        if (toolCallFailure !== undefined) {
            alerts.push(createCollectionFailure(
                snapshot.name,
                "tool call history",
                toolCallFailure
            ));
        }
        const recentFailure = createRecentFailureAlert(
            snapshot.name,
            failureResult.status === "fulfilled" ? failureResult.value : { count: 0 },
        );
        if (recentFailure.alert !== undefined) {
            alerts.push(recentFailure.alert);
        }

        return {
            activity: selectOperationalActivity(calls, this.#activityLimit),
            alerts,
            failedCalls24h: recentFailure.count,
            instance: {
                mcpEnabled: descriptor.mcpEnabled,
                name: snapshot.name,
                pendingApprovals,
                provider: descriptor.provider,
                snapshot,
                ...(descriptor.worker.handshake === undefined
                    ? {}
                    : { worker: toOperationalWorker(descriptor.worker.handshake) })
            },
            todos
        };
    }
}

function toOperationalWorker(
    handshake: NonNullable<InstanceDescriptor["worker"]["handshake"]>
): OperationalOverviewWorker {
    return {
        capabilities: { ...handshake.capabilities },
        platform: {
            arch: handshake.platform.arch,
            ...(handshake.platform.distribution === undefined
                ? {}
                : { distribution: { ...handshake.platform.distribution } }),
            os: handshake.platform.os,
            ...(handshake.platform.packageManager === undefined
                ? {}
                : { packageManager: handshake.platform.packageManager }),
            ...(handshake.platform.shell === undefined
                ? {}
                : { shell: { ...handshake.platform.shell } })
        },
        protocolVersion: handshake.protocolVersion,
        version: handshake.workerVersion
    };
}

function readSnapshot(descriptor: InstanceDescriptor): InstanceSnapshot {
    try {
        return descriptor.worker.snapshot();
    } catch (error) {
        const name = asInstanceName(descriptor.name);
        const failure = createCollectionFailure(name, "instance snapshot", error);
        return {
            connectionState: "failed",
            daemonState: "failed",
            lastErrorMessage: failure.detail,
            lastSeq: 0,
            name,
            ready: false,
            status: "failed"
        };
    }
}
