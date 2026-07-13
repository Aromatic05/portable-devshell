import type { ArtifactEventType } from "../artifact/DtoArtifact.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export type InstanceEventType = ArtifactEventType
    | "instance.started"
    | "instance.stopped"
    | "instance.statusChanged"
    | "instance.connectionChanged"
    | "instance.readyChanged"
    | "worker.rpcConnected"
    | "worker.rpcDisconnected"
    | "worker.schemaRefreshed"
    | "reverse.connected"
    | "reverse.disconnected"
    | "reverse.enrollmentChanged"
    | "reverse.transportChanged"
    | "toolCall.queued"
    | "toolCall.started"
    | "toolCall.pendingApproval"
    | "toolCall.running"
    | "toolCall.completed"
    | "toolCall.failed"
    | "toolCall.denied"
    | "toolCall.expired"
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
    | "todo.created"
    | "todo.updated"
    | "todo.completed"
    | "todo.archived";

export interface InstanceEvent {
    at: string;
    data?: JsonValue;
    instanceName: InstanceName;
    seq: number;
    type: InstanceEventType;
}
