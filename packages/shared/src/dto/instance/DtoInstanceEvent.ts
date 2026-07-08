import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export type InstanceEventType =
    | "instance.started"
    | "instance.stopped"
    | "instance.statusChanged"
    | "worker.rpcConnected"
    | "worker.rpcDisconnected"
    | "worker.schemaRefreshed"
    | "toolCall.started"
    | "toolCall.completed"
    | "toolCall.failed"
    | "log.appended"
    | "mcp.sessionOpened"
    | "mcp.sessionClosed"
    | "mcp.toolCalled";

export interface InstanceEvent {
    at: string;
    data?: JsonValue;
    instanceName: InstanceName;
    seq: number;
    type: InstanceEventType;
}
