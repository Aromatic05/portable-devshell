// Instance activity: the ordered event taxonomy and the log entries appended
// to the same sequence space. Events are the change signal for every instance
// domain; they are not a state store.

import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { InstanceName } from "../identity/Model.js";
import type { ToolCallSource } from "../tool/Model.js";

export type InstanceEventType =
    | "instance.started"
    | "instance.stopped"
    | "instance.statusChanged"
    | "instance.connectionChanged"
    | "instance.readyChanged"
    | "worker.transportConnected"
    | "worker.transportDisconnected"
    | "worker.schemaRefreshed"
    | "worker.protocolIntegrityFault"
    | "reverse.connected"
    | "reverse.disconnected"
    | "reverse.enrollmentChanged"
    | "reverse.transportChanged"
    | "toolCall.queued"
    | "toolCall.started"
    | "toolCall.running"
    | "toolCall.completed"
    | "toolCall.failed"
    | "toolCall.denied"
    | "toolCall.queueTimeout"
    | "toolCall.cancelled"
    | "log.appended"
    | "mcp.sessionOpened"
    | "mcp.sessionClosed"
    | "mcp.toolCalled"
    | "approval.requested"
    | "approval.approved"
    | "approval.denied"
    | "approval.expired"
    | "approval.cancelled"
    | "context.message.queued"
    | "context.message.delivered"
    | "context.message.failed"
    | "goal.updated"
    | "todo.created"
    | "todo.updated"
    | "todo.completed"
    | "todo.archived"
    | "todo.deleted"
    | "wait.created"
    | "wait.detached"
    | "wait.reattached"
    | "wait.resolved"
    | "wait.recoveryClaimed"
    | "wait.recoveryDismissed"
    | "wait.recoveryMessageAttempted"
    | "wait.recoveryReleased"
    | "wait.consumed"
    | "wait.cancelled";

export interface InstanceEvent {
    at: string;
    data?: JsonValue;
    instanceName: InstanceName;
    seq: number;
    type: InstanceEventType;
}

export interface InstanceLogEntry {
    at: string;
    callId?: string;
    ctxId?: string;
    instanceName: string;
    message: string;
    requestId?: string;
    seq: number;
    source?: ToolCallSource;
    stream: "stderr" | "stdout";
    toolName?: string;
}

export interface InstanceLogQuery {
    fromSeq?: number;
    limit?: number;
    maxDecodedBytes?: number;
}
