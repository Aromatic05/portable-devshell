import { asInstanceName, type ApprovalRequest, type JsonValue, type ToolCallRecord } from "@portable-devshell/shared";

import { asRecord, isApprovalEvent, isStatusEvent, isToolCallEvent, mergeLogEntry, upsertApproval, upsertToolCall } from "./helpers.js";
import type { TuiAppState, TuiRawEventRecord } from "./types.js";

export function applyEventRecord(state: TuiAppState, rawEvent: TuiRawEventRecord): TuiAppState {
    const payload = asRecord(rawEvent.payload);
    const data = asRecord(payload?.data);

    if (payload !== undefined && typeof payload.at === "string" && isStatusEvent(rawEvent.event)) {
        state = {
            ...state,
            lastStatusChangeAtByInstance: {
                ...state.lastStatusChangeAtByInstance,
                [rawEvent.instance]: payload.at
            }
        };
    }

    if (data === undefined) {
        return state;
    }

    if (isStatusEvent(rawEvent.event)) {
        state = applySnapshotEvent(state, rawEvent.instance, rawEvent.seq, typeof payload?.at === "string" ? payload.at : undefined, data);
    }

    if (isToolCallEvent(rawEvent.event)) {
        state = applyToolCallEvent(state, rawEvent.instance, data);
    }

    if (rawEvent.event === "log.appended") {
        state = {
            ...state,
            logsByInstance: {
                ...state.logsByInstance,
                [rawEvent.instance]: mergeLogEntry(state.logsByInstance[rawEvent.instance] ?? [], {
                    at: typeof payload?.at === "string" ? payload.at : undefined,
                    bytes: typeof data.bytes === "number" ? data.bytes : undefined,
                    callId: typeof data.callId === "string" ? data.callId : undefined,
                    instance: rawEvent.instance,
                    preview: typeof data.preview === "string" ? data.preview : undefined,
                    receivedAt: typeof payload?.at === "string" ? payload.at : new Date(0).toISOString(),
                    requestId: typeof data.requestId === "string" ? data.requestId : undefined,
                    seq: rawEvent.seq,
                    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
                    source: data.source === "cli" || data.source === "tui" || data.source === "mcp" ? data.source : undefined,
                    stream: data.stream === "stderr" ? "stderr" : "stdout",
                    tail: typeof data.tail === "string" ? data.tail : undefined,
                    toolName: typeof data.toolName === "string" ? data.toolName : undefined
                })
            }
        };
    }

    if (isApprovalEvent(rawEvent.event)) {
        state = applyApprovalEvent(state, rawEvent.instance, data);
    }

    return state;
}

function applySnapshotEvent(
    state: TuiAppState,
    instance: string,
    seq: number,
    at: string | undefined,
    data: Record<string, JsonValue>
): TuiAppState {
    const current = state.snapshotsByInstance[instance];

    if (current === undefined) {
        return state;
    }

    return {
        ...state,
        lastStatusChangeAtByInstance:
            at === undefined
                ? state.lastStatusChangeAtByInstance
                : {
                      ...state.lastStatusChangeAtByInstance,
                      [instance]: at
                  },
        snapshotsByInstance: {
            ...state.snapshotsByInstance,
            [instance]: {
                ...current,
                connectionState:
                    data.connectionState === "connected" ||
                    data.connectionState === "connecting" ||
                    data.connectionState === "disconnected" ||
                    data.connectionState === "reconnecting" ||
                    data.connectionState === "failed"
                        ? data.connectionState
                        : current.connectionState,
                daemonState:
                    data.daemonState === "running" ||
                    data.daemonState === "starting" ||
                    data.daemonState === "stopped" ||
                    data.daemonState === "stale" ||
                    data.daemonState === "stopping" ||
                    data.daemonState === "failed"
                        ? data.daemonState
                        : current.daemonState,
                lastErrorCode: typeof data.lastErrorCode === "string" ? data.lastErrorCode : current.lastErrorCode,
                lastSeq: seq,
                pid: typeof data.pid === "number" ? data.pid : current.pid,
                ready: typeof data.ready === "boolean" ? data.ready : current.ready,
                status:
                    data.status === "ready" || data.status === "running" || data.status === "stale" || data.status === "stopped" || data.status === "failed"
                        ? data.status
                        : current.status
            }
        }
    };
}

function applyToolCallEvent(state: TuiAppState, instance: string, data: Record<string, JsonValue>): TuiAppState {
    const callId = typeof data.callId === "string" ? data.callId : undefined;

    if (callId === undefined) {
        return state;
    }

    const current = state.toolCallsByInstance[instance] ?? [];
    const existing = current.find((record) => record.callId === callId);
    const nextRecord: ToolCallRecord = {
        approvalId: typeof data.approvalId === "string" ? data.approvalId : existing?.approvalId,
        callId,
        completedAt: typeof data.completedAt === "string" ? data.completedAt : existing?.completedAt,
        decision: data.decision === "approved" || data.decision === "denied" || data.decision === "expired" ? data.decision : existing?.decision,
        error: typeof data.errorCode === "string" ? data.errorCode : existing?.error,
        exitCode: typeof data.exitCode === "number" || data.exitCode === null ? data.exitCode : existing?.exitCode,
        inputSummary: typeof data.inputSummary === "string" ? data.inputSummary : existing?.inputSummary ?? "",
        instance: asInstanceName(instance),
        requestId: typeof data.requestId === "string" ? data.requestId : existing?.requestId,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : existing?.sessionId,
        source: data.source === "cli" || data.source === "tui" || data.source === "mcp" ? data.source : existing?.source ?? "tui",
        startedAt: typeof data.startedAt === "string" ? data.startedAt : existing?.startedAt ?? new Date(0).toISOString(),
        status:
            data.status === "pendingApproval" ||
            data.status === "running" ||
            data.status === "completed" ||
            data.status === "failed" ||
            data.status === "denied" ||
            data.status === "expired"
                ? data.status
                : existing?.status ?? "running",
        stderrBytes: typeof data.stderrBytes === "number" ? data.stderrBytes : existing?.stderrBytes,
        stdoutBytes: typeof data.stdoutBytes === "number" ? data.stdoutBytes : existing?.stdoutBytes,
        timedOut: data.timedOut === true ? true : existing?.timedOut ?? false,
        toolName: typeof data.toolName === "string" ? data.toolName : existing?.toolName ?? ""
    };

    return {
        ...state,
        toolCallsByInstance: {
            ...state.toolCallsByInstance,
            [instance]: upsertToolCall(current, nextRecord)
        }
    };
}

function applyApprovalEvent(state: TuiAppState, instance: string, data: Record<string, JsonValue>): TuiAppState {
    const approvalId = typeof data.approvalId === "string" ? data.approvalId : undefined;
    const callId = typeof data.callId === "string" ? data.callId : undefined;
    const createdAt = typeof data.createdAt === "string" ? data.createdAt : undefined;
    const expiresAt = typeof data.expiresAt === "string" ? data.expiresAt : undefined;
    const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
    const status = data.status;
    const source = data.source;
    const riskLevel = data.riskLevel;
    const current = state.approvalsByInstance[instance] ?? [];
    const existing = approvalId === undefined ? undefined : current.find((approval) => approval.approvalId === approvalId);

    if (
        approvalId === undefined ||
        callId === undefined ||
        createdAt === undefined ||
        expiresAt === undefined ||
        toolName === undefined ||
        (status !== "pending" && status !== "approved" && status !== "denied" && status !== "expired") ||
        (source !== "cli" && source !== "tui" && source !== "mcp") ||
        (riskLevel !== "low" && riskLevel !== "medium" && riskLevel !== "high")
    ) {
        return state;
    }

    const next: ApprovalRequest = {
        approvalId,
        callId,
        createdAt,
        decision:
            data.decision === "approve" || data.decision === "deny"
                ? {
                      approvalId,
                      decidedAt: typeof data.decidedAt === "string" ? data.decidedAt : existing?.decision?.decidedAt ?? createdAt,
                      decidedBy: data.decidedBy === "cli" || data.decidedBy === "tui" || data.decidedBy === "policy" ? data.decidedBy : "tui",
                      decision: data.decision,
                      policyPatch: data.policyPatch,
                      reason: typeof data.reason === "string" ? data.reason : undefined,
                      remember: data.remember === true ? true : undefined
                  }
                : existing?.decision,
        expiresAt,
        inputSummary: typeof data.inputSummary === "string" ? data.inputSummary : existing?.inputSummary ?? "",
        instance: asInstanceName(instance),
        reason: typeof data.reason === "string" ? data.reason : existing?.reason ?? "",
        requestId: typeof data.requestId === "string" ? data.requestId : existing?.requestId,
        riskLevel,
        sessionId: typeof data.sessionId === "string" ? data.sessionId : existing?.sessionId,
        source,
        status,
        toolName
    };

    return {
        ...state,
        approvalsByInstance: {
            ...state.approvalsByInstance,
            [instance]: upsertApproval(current, next)
        }
    };
}
