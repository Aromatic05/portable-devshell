import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import { asArray, asBoolean, asNumber, asRecord, asString } from "../JsonRead.js";
import { diagnosticHint, errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";
import { workerCommonErrorHints } from "./WorkerCommonHints.js";

const warningTexts: Record<string, string> = {
    "tmux.blockTimeout":
        "Task still running; continue with tmux_wait.",
    "tmux.taskAdopted":
        "Continue using the existing task id.",
    "tmux.outputSkipped":
        "Earlier unread output was skipped.",
    "tmux.outputDropped":
        "Old output was dropped.",
    "tmux.windowResync":
        "Pane history was resynchronized.",
    "tmux.foreignPanes":
        "Unmanaged panes are omitted.",
    "tmux.paneCollected":
        "Use a current pane.",
    "tmux.capacityFull":
        "Reuse or close a pane.",
    "tmux.observationReset":
        "Output history may be incomplete."
};

function warningHints(warnings: JsonValue[] | undefined): ToolDiagnosticHint[] {
    if (warnings === undefined) return [];
    const hints: ToolDiagnosticHint[] = [];
    for (const entry of warnings) {
        const code = asString(asRecord(entry)?.code);
        if (code === undefined) continue;
        const text = warningTexts[code];
        if (text !== undefined) hints.push(diagnosticHint(code, text));
    }
    return hints;
}

function hasWarningCode(warnings: JsonValue[] | undefined, code: string): boolean {
    if (warnings === undefined) return false;
    return warnings.some((entry) => asString(asRecord(entry)?.code) === code);
}

function taskStatusHints(task: Record<string, JsonValue> | undefined): ToolDiagnosticHint[] {
    if (task === undefined) return [];
    const status = asString(task.status);
    if (status === undefined || status === "running" || status === "0") return [];
    if (status === "unknown") {
        return [errorHint(
            "tmux.taskStatusUnknown",
            "Inspect the pane before retrying."
        )];
    }
    if (asNumber(status as unknown as JsonValue) !== undefined || /^-?\d+$/.test(status)) {
        return [errorHint(
            "tmux.taskFailed",
            `Exited with status ${status}; inspect output.`
        )];
    }
    return [];
}

export function tmuxTaskResultHints(toolName: string, result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const warnings = asArray(record.warnings);
    const hints: ToolDiagnosticHint[] = [...warningHints(warnings)];

    if (toolName === "tmux_run" &&
        asString(asRecord(record.task)?.status) === "running" &&
        !hasWarningCode(warnings, "tmux.blockTimeout")) {
        hints.push(diagnosticHint(
            "tmux.taskRunning",
            "Continue with tmux_wait."
        ));
    }

    if (toolName === "tmux_wait" && asBoolean(record.detached) === true) {
        hints.push(diagnosticHint(
            "tmux.waitDetached",
            "The task is still running in its tmux window. Do not poll. Workspace owns this wait and will resume the model when the task completes."
        ));
    }

    hints.push(...taskStatusHints(asRecord(record.task)));

    if (asBoolean(record.observationReset) === true) {
        hints.push(diagnosticHint(
            "tmux.observationReset",
            "Output history may be incomplete."
        ));
    }

    return hints;
}

export function tmuxInspectResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const hints: ToolDiagnosticHint[] = [...warningHints(asArray(record.warnings))];
    if (asBoolean(record.observationReset) === true) {
        hints.push(diagnosticHint(
            "tmux.observationReset",
            "Inspect shows current terminal state only."
        ));
    }
    return hints;
}

export function tmuxListResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const hints: ToolDiagnosticHint[] = [...warningHints(asArray(record.warnings))];
    const capacity = asRecord(record.capacity);
    const used = asNumber(capacity?.used);
    const max = asNumber(capacity?.max);
    if (used !== undefined && max !== undefined && used >= max && max > 0) {
        hints.push(diagnosticHint(
            "tmux.capacityFull",
            "Reuse or close a pane."
        ));
    }
    if (asBoolean(record.observationReset) === true) {
        hints.push(diagnosticHint(
            "tmux.observationReset",
            "Pane state was resynchronized."
        ));
    }
    return hints;
}

export function tmuxCreateResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    return warningHints(asArray(record.warnings));
}

export function tmuxCloseResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    return warningHints(asArray(record.warnings));
}

export function tmuxErrorHints(toolName: string, body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "tmux.taskStartUnconfirmed":
            return [errorHint(
                "tmux.taskStartUnconfirmed",
                "Check tmux_list or tmux_inspect before retrying."
            )];
        case "tmux.taskNotRunning":
            return [errorHint(
                "tmux.taskNotRunning",
                "Read final output or start a new task."
            )];
        case "tmux.taskExpired":
            return [errorHint(
                "tmux.taskExpired",
                "Refresh tmux_list or tmux_inspect."
            )];
        case "tmux.capacityReached":
            return [errorHint(
                "tmux.capacityReached",
                "Reuse or close a pane."
            )];
        case "tmux.paneBusy":
            return [errorHint(
                "tmux.paneBusy",
                "Read or inspect the running task first."
            )];
        case "tmux.paneNotReady":
            return [errorHint(
                "tmux.paneNotReady",
                "Refresh pane state before retrying."
            )];
        case "tmux.paneNotFound":
            return [errorHint(
                "tmux.paneNotFound",
                "Refresh tmux_list and use a current pane."
            )];
        case "tmux.paneNameExists":
            return [errorHint(
                "tmux.paneNameExists",
                "Reuse the pane or choose another name."
            )];
        case "tmux.lastPane":
            return [errorHint(
                "tmux.lastPane",
                "Keep the final managed pane."
            )];
        case "tmux.invalidCwd":
            return [errorHint(
                "tmux.invalidCwd",
                "Use ./ for a workspace-relative cwd or / for an absolute cwd."
            )];
        case "tmux.invalidInput":
        case "tmux.invalidFormat":
            return [errorHint(
                body.code,
                "Fix the input encoding."
            )];
        case "tmux.invalidPaneName":
            return [errorHint(
                "tmux.invalidPaneName",
                "Use a valid pane name."
            )];
        case "tmux.requestIdConflict":
            return [errorHint(
                "tmux.requestIdConflict",
                "Use a fresh operation id."
            )];
        case "tmux.startFailed":
        case "tmux.createFailed":
            return [errorHint(
                body.code,
                "Check tmux_list and the tmux runtime."
            )];
        case "tmux.unavailable":
            return [errorHint(
                "tmux.unavailable",
                "Check the tmux installation."
            )];
        case "tmux.commandFailed":
            return [errorHint(
                "tmux.commandFailed",
                "Inspect tmux server state."
            )];
        case "tmux.runtimeConflict":
            return [errorHint(
                "tmux.runtimeConflict",
                "Resolve the tmux runtime conflict."
            )];
        case "tmux.storageFailed":
            return [errorHint(
                "tmux.storageFailed",
                "Inspect worker storage."
            )];
        case "tmux.internalError":
        case "tmux.gcFailed":
            return [errorHint(
                body.code,
                "Inspect worker tmux state."
            )];
        case "tool.cancelled":
            return [errorHint(
                "tool.cancelled",
                toolName === "tmux_run" || toolName === "tmux_input" || toolName === "tmux_read" || toolName === "tmux_wait"
                    ? "Wait cancelled; continue using the same task id."
                    : "Retry if the result is still needed."
            )];
        default:
            return workerCommonErrorHints(body);
    }
}
