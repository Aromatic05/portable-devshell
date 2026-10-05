import { asInstanceName, type OperationalOverviewActivity, type OperationalOverviewAlert, type OperationalOverviewInstance, type OperationalOverviewTodo, type ToolCallQuery, type ToolCallRecord } from "@portable-devshell/shared";
import type { Instance } from "@portable-devshell/core";
import type { ApprovalApi } from "@portable-devshell/core/approval";
import type { TaskApi } from "@portable-devshell/core/task";
import { createCollectionFailure, createRecentFailureAlert, createSnapshotAlerts, createTodoAlerts, selectOperationalActivity } from "./Policy.js";

export interface OperationalOverviewInstanceData {
    approval: Pick<ApprovalApi, "listPendingApprovals">;
    task: Pick<TaskApi, "todo">;
    tools: {
        readToolCalls(query: ToolCallQuery): Promise<ToolCallRecord[]>;
        readToolCallFailureSummary(sinceMs: number, untilMs: number): Promise<{ count: number; latest?: ToolCallRecord }>;
    };
}

export interface OperationalOverviewInstanceCollection {
    activity: OperationalOverviewActivity[];
    alerts: OperationalOverviewAlert[];
    failedCalls24h: number;
    instance: OperationalOverviewInstance;
    todos: OperationalOverviewTodo[];
}

export class OperationalOverviewInstanceCollector {
    constructor(readonly options: {
        activityLimit: number;
        instanceData(descriptor: Instance): OperationalOverviewInstanceData;
    }) {}

    async collect(descriptor: Instance, now: Date): Promise<OperationalOverviewInstanceCollection> {
        const name = asInstanceName(descriptor.name);
        const alerts: OperationalOverviewAlert[] = [];
        const read = async <T>(subject: string, operation: () => T | Promise<T>, failed: T): Promise<T> => {
            try { return await operation(); }
            catch (error) { alerts.push(createCollectionFailure(name, subject, error)); return failed; }
        };
        const snapshot = await read("snapshot", () => descriptor.worker.snapshot(), {
            connectionState: "failed", daemonState: "failed", lastSeq: 0,
            name, ready: false, status: "failed",
        } as ReturnType<Instance["worker"]["snapshot"]>);
        alerts.push(...createSnapshotAlerts(name, snapshot));
        const data = this.options.instanceData(descriptor);
        const [pending, todos, records, failure] = await Promise.all([
            read("approvals", () => data.approval.listPendingApprovals(), []),
            read("todos", () => data.task.todo.summaries().map(todo => ({ ...todo, instance: name })), []),
            read("activity", () => data.tools.readToolCalls({ includeInput: false, includeOutput: false, limit: this.options.activityLimit, maxBytes: 128 * 1024 }), []),
            read("tool failures", () => data.tools.readToolCallFailureSummary(now.getTime() - 24 * 60 * 60 * 1000, now.getTime()), { count: 0 }),
        ]);
        if (pending.length > 0) alerts.push({ id: `approval.pending:${name}`, instance: name, kind: "approval.pending", severity: "attention", title: "Approval required", detail: `${pending.length} approval requests waiting.` });
        alerts.push(...createTodoAlerts(name, todos));
        const recent = createRecentFailureAlert(name, failure);
        if (recent.alert !== undefined) alerts.push(recent.alert);
        const handshake = descriptor.worker.handshake;
        return {
            activity: selectOperationalActivity(records, this.options.activityLimit), alerts, failedCalls24h: recent.count, todos,
            instance: {
                mcpEnabled: descriptor.mcpEnabled, name, pendingApprovals: pending.length, provider: descriptor.provider, snapshot,
                ...(handshake === undefined ? {} : { worker: { capabilities: handshake.capabilities, platform: handshake.platform, protocolVersion: handshake.protocolVersion, version: handshake.workerVersion } }),
            },
        };
    }
}
