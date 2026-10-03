import type { JsonValue } from "../../types/Json.js";
import type { InstanceLogEntry } from "../process/Event.js";
import type { ToolCallRecord, ToolCallStatus } from "./Model.js";

const failedStatuses = new Set<ToolCallStatus>([
    "cancelled",
    "denied",
    "failed",
    "queueTimeout",
]);
const pendingStatuses = new Set<ToolCallStatus>(["queued", "running"]);

export function resolveToolOutput(
    output: JsonValue | undefined,
    callId: string,
    logs: readonly Pick<InstanceLogEntry, "callId" | "message" | "stream">[],
): JsonValue | undefined {
    const linked = logs.filter((entry) => entry.callId === callId);
    const stdout = linked
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.message)
        .join("");
    const stderr = linked
        .filter((entry) => entry.stream === "stderr")
        .map((entry) => entry.message)
        .join("");
    if (stdout.length === 0 && stderr.length === 0) return output;
    const streams: Record<string, JsonValue> = {
        ...(stderr.length === 0 ? {} : { stderr }),
        ...(stdout.length === 0 ? {} : { stdout }),
    };
    if (output === undefined) return streams;
    if (typeof output !== "object" || output === null || Array.isArray(output))
        return output;
    return { ...streams, ...output };
}

export function toolCallOutcome(
    status: ToolCallStatus,
): "failure" | "pending" | "success" {
    if (status === "completed") return "success";
    if (pendingStatuses.has(status)) return "pending";
    return failedStatuses.has(status) ? "failure" : "failure";
}

export function toolCallOutput(
    call: ToolCallRecord,
    logs: readonly InstanceLogEntry[],
): JsonValue | undefined {
    return resolveToolOutput(call.output, call.callId, logs);
}
