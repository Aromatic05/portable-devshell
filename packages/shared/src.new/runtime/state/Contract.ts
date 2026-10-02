// Runtime wire contract. Cursor-bearing envelopes make the read-then-subscribe
// handoff explicit: every authoritative read returns the instance sequence at
// read time, and subscribe resumes at lastSeq + 1.

import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { InstanceEventSubscribeRequest } from "../activity/Contract.js";
import type { InstanceLogEntry, InstanceLogQuery } from "../activity/Model.js";
import type { InstanceRuntimeEnvelope, InstanceSnapshot } from "./Model.js";

export const runtimeOperations = {
    readLogs: "readLogs",
    refresh: "refresh",
    snapshot: "snapshot",
    start: "start",
    stop: "stop",
    subscribe: "subscribe",
} as const;

export interface RuntimeContract {
    readLogs: {
        request: InstanceLogQuery | undefined;
        response: InstanceLogEntry[];
    };
    refresh: {
        request: undefined;
        response: InstanceRuntimeEnvelope;
    };
    snapshot: {
        request: undefined;
        response: InstanceRuntimeEnvelope;
    };
    stop: {
        request: undefined;
        response: InstanceSnapshot;
    };
}

export type RuntimeOperation = keyof RuntimeContract;

export type RuntimeRequest<Operation extends RuntimeOperation> =
    RuntimeContract[Operation]["request"];

export type RuntimeResponse<Operation extends RuntimeOperation> =
    RuntimeContract[Operation]["response"];

export type RuntimeSubscribeRequest = InstanceEventSubscribeRequest;

export function readInstanceSnapshot(
    value: JsonValue | undefined,
): InstanceSnapshot {
    const snapshot = record(value);
    if (
        snapshot === undefined ||
        typeof snapshot.name !== "string" ||
        typeof snapshot.lastSeq !== "number" ||
        typeof snapshot.ready !== "boolean" ||
        !isOneOf(snapshot.connectionState, [
            "connected",
            "connecting",
            "disconnected",
            "reconnecting",
            "failed",
        ]) ||
        !isOneOf(snapshot.daemonState, [
            "running",
            "starting",
            "stopped",
            "stale",
            "stopping",
            "failed",
        ]) ||
        !isOneOf(snapshot.status, [
            "ready",
            "running",
            "stale",
            "stopped",
            "failed",
        ])
    ) {
        throw new Error("Invalid runtime snapshot.");
    }
    return snapshot as unknown as InstanceSnapshot;
}

function record(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function isOneOf<T extends string>(
    value: JsonValue | undefined,
    values: readonly T[],
): value is T {
    return typeof value === "string" && values.includes(value as T);
}
