import type { JsonValue } from "../types/JsonValue.js";
import type { InstanceName } from "../types/InstanceName.js";

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
