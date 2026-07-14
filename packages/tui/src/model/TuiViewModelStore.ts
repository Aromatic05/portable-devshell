import { asInstanceName, type ApprovalRequest, type ConnectionState, type DaemonState, type InstanceSnapshot, type JsonValue, type RuntimeStatus, type ToolCallRecord } from "@portable-devshell/shared";

import {
    TuiApprovalInboxModel,
    TuiConfigModel,
    type TuiControlEventEnvelope,
    type TuiConfigView,
    TuiInstanceModel,
    TuiLogModel,
    type TuiLogEntry,
    type TuiInstanceView,
    TuiToolAuditModel
} from "./TuiModels.js";

export type TuiControlConnectionState = "connected" | "connecting" | "disconnected" | "error";

export interface TuiControlConnectionView {
    errorCode?: string;
    errorMessage?: string;
    state: TuiControlConnectionState;
}

export interface TuiViewSnapshot {
    approvals: ApprovalRequest[];
    config?: TuiConfigView;
    connection: TuiControlConnectionView;
    instances: TuiInstanceView[];
    logs: TuiLogEntry[];
    toolAudit: ToolCallRecord[];
}

export class TuiViewModelStore {
    readonly #approvalInbox = new TuiApprovalInboxModel();
    readonly #config = new TuiConfigModel();
    readonly #instances = new TuiInstanceModel();
    readonly #logs = new TuiLogModel();
    readonly #toolAudit = new TuiToolAuditModel();
    #connection: TuiControlConnectionView = { state: "disconnected" };

    setConnectionState(state: TuiControlConnectionState, error?: { code?: string; message?: string }): void {
        this.#connection = {
            ...(error?.code === undefined ? {} : { errorCode: error.code }),
            ...(error?.message === undefined ? {} : { errorMessage: error.message }),
            state
        };
    }

    resetInstances(entries: ReadonlyArray<{ mcpEnabled: boolean; name: string }>): void {
        this.#instances.reset(entries);
        const names = new Set(entries.map((entry) => entry.name));
        this.#approvalInbox.pruneInstances(names);
        this.#logs.pruneInstances(names);
        this.#toolAudit.pruneInstances(names);
    }

    setConfigView(view: TuiConfigView): void {
        this.#config.set(view);
    }

    upsertSnapshot(snapshot: InstanceSnapshot): void {
        this.#instances.upsertSnapshot(snapshot);
    }

    replaceToolCalls(instance: string, records: ReadonlyArray<ToolCallRecord>): void {
        this.#toolAudit.replaceInstance(instance, records);
    }

    replaceApprovals(instance: string, approvals: ReadonlyArray<ApprovalRequest>): void {
        this.#approvalInbox.replaceInstance(instance, approvals);
    }

    applyEvent(envelope: TuiControlEventEnvelope): void {
        if (envelope.event === "stream.gap" || envelope.event === "stream.cancelled") {
            return;
        }

        const instance = envelope.target.instance;
        const payload = asRecord(envelope.payload as JsonValue | undefined);
        const data = asRecord(payload?.data);

        if (data !== undefined) {
            this.#applySnapshotEvent(instance, envelope.event, envelope.seq, data);
            this.#toolAudit.upsertEvent(instance, envelope.event, data);

            if (
                envelope.event === "approval.requested" ||
                envelope.event === "approval.approved" ||
                envelope.event === "approval.denied" ||
                envelope.event === "approval.expired" ||
                envelope.event === "approval.cancelled"
            ) {
                this.#approvalInbox.upsertEvent(instance, data);
            }

            if (envelope.event === "log.appended") {
                this.#appendLogEvent(instance, envelope.seq, data);
            }
        }
    }

    getConnection(): TuiControlConnectionView {
        return { ...this.#connection };
    }

    listInstances(): TuiInstanceView[] {
        return this.#instances.list();
    }

    getInstance(instance: string): TuiInstanceView | undefined {
        return this.#instances.get(instance);
    }

    getSnapshot(instance: string): InstanceSnapshot | undefined {
        return this.#instances.get(instance)?.snapshot;
    }

    getLogTail(instance?: string): TuiLogEntry[] {
        return this.#logs.list(instance);
    }

    getToolAudit(instance?: string): ToolCallRecord[] {
        return this.#toolAudit.list(instance);
    }

    getPendingApprovals(instance?: string): ApprovalRequest[] {
        return this.#approvalInbox.listPending(instance);
    }

    getConfigView(): TuiConfigView | undefined {
        return this.#config.get();
    }

    snapshot(): TuiViewSnapshot {
        return {
            approvals: this.getPendingApprovals(),
            config: this.getConfigView(),
            connection: this.getConnection(),
            instances: this.listInstances(),
            logs: this.getLogTail(),
            toolAudit: this.getToolAudit()
        };
    }

    #applySnapshotEvent(instance: string, eventType: string, seq: number, data: Record<string, JsonValue>): void {
        if (
            eventType !== "instance.statusChanged" &&
            eventType !== "instance.connectionChanged" &&
            eventType !== "instance.readyChanged"
        ) {
            return;
        }

        const current = this.#instances.get(instance)?.snapshot;

        if (current === undefined) {
            return;
        }

        this.#instances.upsertSnapshot({
            ...current,
            connectionState: readConnectionState(data.connectionState) ?? current.connectionState,
            daemonState: readDaemonState(data.daemonState) ?? current.daemonState,
            lastErrorCode: readString(data.lastErrorCode),
            lastSeq: seq,
            name: asInstanceName(instance),
            pid: readNumber(data.pid),
            ready: readBoolean(data.ready) ?? current.ready,
            status: readRuntimeStatus(data.status) ?? current.status
        });
    }

    #appendLogEvent(instance: string, seq: number, data: Record<string, JsonValue>): void {
        const stream = data.stream;
        const bytes = readNumber(data.bytes);

        if ((stream !== "stdout" && stream !== "stderr") || bytes === undefined) {
            return;
        }

        this.#logs.append({
            bytes,
            ...(readString(data.callId) === undefined ? {} : { callId: readString(data.callId) }),
            instance,
            ...(readString(data.preview) === undefined ? {} : { preview: readString(data.preview) }),
            receivedAt: new Date().toISOString(),
            ...(readString(data.requestId) === undefined ? {} : { requestId: readString(data.requestId) }),
            seq,
            ...(readString(data.sessionId) === undefined ? {} : { sessionId: readString(data.sessionId) }),
            ...(data.source === "cli" || data.source === "tui" || data.source === "mcp" ? { source: data.source } : {}),
            stream,
            ...(readString(data.tail) === undefined ? {} : { tail: readString(data.tail) }),
            ...(readString(data.toolName) === undefined ? {} : { toolName: readString(data.toolName) })
        });
    }
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function readString(value: JsonValue | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function readNumber(value: JsonValue | undefined): number | undefined {
    return typeof value === "number" ? value : undefined;
}

function readBoolean(value: JsonValue | undefined): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function readConnectionState(value: JsonValue | undefined): ConnectionState | undefined {
    return value === "connected" || value === "connecting" || value === "disconnected" || value === "reconnecting" || value === "failed"
        ? value
        : undefined;
}

function readDaemonState(value: JsonValue | undefined): DaemonState | undefined {
    return value === "running" || value === "starting" || value === "stopped" || value === "stopping" || value === "stale" || value === "failed"
        ? value
        : undefined;
}

function readRuntimeStatus(value: JsonValue | undefined): RuntimeStatus | undefined {
    return value === "ready" || value === "running" || value === "stale" || value === "stopped" || value === "failed" ? value : undefined;
}
