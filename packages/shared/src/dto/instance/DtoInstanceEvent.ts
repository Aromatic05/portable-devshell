import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export type InstanceEventType =
    | "instance.started"
    | "instance.stopped"
    | "instance.statusChanged"
    | "instance.connectionChanged"
    | "instance.readyChanged"
    | "worker.rpcConnected"
    | "worker.rpcDisconnected"
    | "worker.schemaRefreshed"
    | "toolCall.started"
    | "toolCall.pendingApproval"
    | "toolCall.running"
    | "toolCall.completed"
    | "toolCall.failed"
    | "toolCall.denied"
    | "toolCall.expired"
    | "log.appended"
    | "mcp.sessionOpened"
    | "mcp.sessionClosed"
    | "mcp.toolCalled"
    | "approval.requested"
    | "approval.approved"
    | "approval.denied"
    | "approval.expired";

export interface InstanceEvent {
    at: string;
    data?: JsonValue;
    instanceName: InstanceName;
    seq: number;
    type: InstanceEventType;
}
