import type { JsonValue } from "../../types/Json.js";

type ResultRecord = Record<string, JsonValue>;

export const processModelOutputHint = "Result: exitCode for normal completion; a running task returns task (ID string) and cursor. Pass them directly to task_input. Exceptional termination and incomplete output include recovery details.";

/**
 * Model-facing projection only. The Worker result is still the authoritative
 * execution/audit record. Keep recovery data while measuring/clipping output;
 * remove it from a complete result only after the final preview is selected.
 */
export function compactProcessModelOutput(
    source: ResultRecord,
    reserveRecovery = false,
): ResultRecord {
    if (isRecord(source.error)) return source;

    const result = { ...source };
    const descriptor = isRecord(source.task) ? source.task : undefined;
    const task = typeof source.task === "string" ? source.task
        : typeof descriptor?.id === "string" ? descriptor.id : undefined;
    const running = source.termination === "running" ||
        (source.termination === undefined && descriptor?.status === "running");

    if (source.timedOut === true) result.termination = "timeout";
    else if ((source.termination === "exited" && typeof source.exitCode === "number") ||
        (running && task !== undefined && source.exitCode === undefined))
        delete result.termination;
    delete result.timedOut;
    delete result.waitMs;
    delete result.untilExit;
    if (["terminal", "output", "timeout"].includes(String(source.waitReason)))
        delete result.waitReason;
    if (source.detached === false) delete result.detached;

    delete result.task;
    if (descriptor?.humanControl === true) result.humanControl = true;
    if (descriptor?.alternateScreen === true) result.alternateScreen = true;
    if (result.humanControl === false) delete result.humanControl;
    if (result.alternateScreen === false) delete result.alternateScreen;

    // Only expose stream metadata when a stream is incomplete. Artifact
    // bookkeeping stays internal; a partial recovery artifact is an exception.
    for (const stream of ["stdout", "stderr"] as const) {
        const truncated = source[stream + "Truncated"] === true;
        const artifact = source[stream + "Artifact"];
        const artifactPartial = isRecord(artifact) && artifact.artifactTruncated === true ||
            source[stream + "ArtifactTruncated"] === true;
        delete result[stream + "Artifact"];
        delete result[stream + "ArtifactTruncated"];
        if (!truncated) delete result[stream + "Truncated"];
        if (!truncated && !reserveRecovery) {
            delete result[stream + "Bytes"];
            delete result[stream + "Path"];
        }
        if (artifactPartial && typeof result[stream + "Path"] === "string")
            result[stream + "ArtifactTruncated"] = true;
        if (result[stream] === "") delete result[stream];
    }
    if (Array.isArray(source.artifactWarnings) && source.artifactWarnings.length === 0)
        delete result.artifactWarnings;

    const incomplete = result.stdoutTruncated === true || result.stderrTruncated === true;
    // For a running task the id is also its implicit running-state marker.
    // Terminal observations keep a handle only if another observation may be needed.
    const needsTask = reserveRecovery || running || incomplete ||
        source.detached === true || isRecord(source.waitError) ||
        result.humanControl === true || result.alternateScreen === true ||
        (task !== undefined && source.termination === undefined &&
            source.exitCode === undefined && source.termSignal === undefined);
    if (needsTask && task !== undefined) result.task = task;
    else delete result.cursor;
    return result;
}

function isRecord(value: JsonValue | undefined): value is ResultRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
