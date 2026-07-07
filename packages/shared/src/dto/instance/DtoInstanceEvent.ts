import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export type InstanceEventType =
    | "instance.started"
    | "instance.stopped"
    | "instance.statusChanged"
    | "instance.toolCalled";

export interface InstanceEvent {
    at: string;
    data?: JsonValue;
    instanceName: InstanceName;
    seq: number;
    type: InstanceEventType;
}
