import type { ApprovalDecision, ApprovalRequest, JsonValue } from "@portable-devshell/shared";

import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";

export function toEventData(
    record: Record<string, JsonValue | undefined>
): Record<string, JsonValue> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Record<string, JsonValue>;
}

export function toApprovalEventData(request: ApprovalRequest, decision?: ApprovalDecision): Record<string, JsonValue> {
    return toEventData({
        approvalId: request.approvalId,
        callId: request.callId,
        createdAt: request.createdAt,
        decidedAt: decision?.decidedAt,
        decidedBy: decision?.decidedBy,
        decision: decision?.decision,
        expiresAt: request.expiresAt,
        inputSummary: request.inputSummary,
        reason: decision?.reason ?? request.reason,
        requestId: request.requestId,
        remember: decision?.remember,
        riskLevel: request.riskLevel,
        ctxId: request.ctxId,
        source: request.source,
        status: request.status,
        toolName: request.toolName
    });
}

export function createStatusChangedEventData(previous: InstanceSnapshot, next: InstanceSnapshot): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        pid: next.pid,
        previousDaemonState: previous.daemonState,
        previousStatus: previous.status,
        ready: next.ready,
        status: next.status
    });
}

export function createConnectionChangedEventData(previous: InstanceSnapshot, next: InstanceSnapshot): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        pid: next.pid,
        previousConnectionState: previous.connectionState,
        ready: next.ready,
        status: next.status
    });
}

export function createReadyChangedEventData(previous: InstanceSnapshot, next: InstanceSnapshot): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        pid: next.pid,
        previousReady: previous.ready,
        ready: next.ready,
        status: next.status
    });
}

