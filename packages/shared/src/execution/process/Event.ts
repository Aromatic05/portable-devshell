import type { InstanceEventRecord } from "../../client/Stream.js";
import type { ToolCallSource } from "../tool/Model.js";

export type ProcessEventType =
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
    | "log.appended";

export type ProcessEvent = InstanceEventRecord<ProcessEventType>;

export function isProcessEventType(type: string): type is ProcessEventType {
    return (
        type.startsWith("instance.") ||
        type.startsWith("worker.") ||
        type.startsWith("reverse.") ||
        type === "log.appended"
    );
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
