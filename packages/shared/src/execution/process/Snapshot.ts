// Process wire contract. Cursor-bearing envelopes make the read-then-subscribe
// handoff explicit: every authoritative read returns the instance sequence at
// read time, and subscribe resumes at lastSeq + 1.

import type { JsonValue } from "../../types/Json.js";
import type { InstanceSnapshot } from "./Model.js";

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
        throw new Error("Invalid process snapshot.");
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
