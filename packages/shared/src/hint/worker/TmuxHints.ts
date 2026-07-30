import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import { asArray, asBoolean, asNumber, asRecord, asString } from "../JsonRead.js";
import { diagnosticHint, errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";
import { workerCommonErrorHints } from "./WorkerCommonHints.js";

const warningTexts: Record<string, string> = {
    "tmux.blockTimeout":
        "The call's wait time ended but the task is still running; the command was not killed. Continue with tmux_read, tmux_inspect, or tmux_input; do not restart the same command or report it as failed or completed.",
    "tmux.taskAdopted":
        "A managed task survived a worker restart and was automatically adopted. Keep using the existing task id and read or inspect it first; do not start a duplicate task or call a reclaim tool.",
    "tmux.outputSkipped":
        "Earlier unread output was deliberately skipped via a negative tail and will not be returned again. Do not claim to have read the complete task output.",
    "tmux.outputDropped":
        "The bounded unread window dropped the oldest output, so the current output is incomplete. Do not reconstruct the full execution history from this window.",
    "tmux.windowResync":
        "The pane history changed outside the task window and observation was resynced, so an unobserved gap may be missing. Do not assert a continuous complete history from the current window.",
    "tmux.foreignPanes":
        "The result includes only portable-devshell managed panes; the tmux server has additional unmanaged panes. Do not describe this listing as the full tmux server state.",
    "tmux.paneCollected":
        "An automatic pane was collected and is no longer usable. Use the panes returned by the current list."
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
            "The worker cannot confirm the task's final state. Investigate with pane inspection, tmux_list, and the existing output; do not assume success or immediately relaunch a command that may still have side effects."
        )];
    }
    if (asNumber(status as unknown as JsonValue) !== undefined || /^-?\d+$/.test(status)) {
        return [errorHint(
            "tmux.taskFailed",
            `The task finished with exit status ${status}. Inspect the output; do not send more input to this task or report completion. Fix the cause and start a new task.`
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
            "The task has started and is still running. Continue with tmux_read, tmux_inspect, or tmux_input; do not report completion or launch a duplicate task."
        ));
    }

    hints.push(...taskStatusHints(asRecord(record.task)));

    if (asBoolean(record.observationReset) === true) {
        hints.push(diagnosticHint(
            "tmux.observationReset",
            "Pane observation was reset, so the returned output is not a complete continuous log. Do not treat the current window as the full history."
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
            "Pane observation was reset. For curses or full-screen programs this reflects only the current terminal state; do not treat inspect output as raw process stdout or a complete continuous log."
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
            "Managed pane capacity is full, so new panes cannot be created. Reuse an existing pane or close finished panes; do not keep creating panes."
        ));
    }
    if (asBoolean(record.observationReset) === true) {
        hints.push(diagnosticHint(
            "tmux.observationReset",
            "Pane observation was reset; the listing reflects the resynced state rather than a continuous history."
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
                "The command may already have been sent and a task may be running, but the start was not confirmed. Do not call tmux_run again immediately; first check tmux_list or tmux_inspect, and retry only after confirming nothing started."
            )];
        case "tmux.taskNotRunning":
            return [errorHint(
                "tmux.taskNotRunning",
                "The task has already ended. Do not send more input; read the final output with tmux_read and check the exit status. Start a new task if you need to run again."
            )];
        case "tmux.taskExpired":
            return [errorHint(
                "tmux.taskExpired",
                "The completed task record has expired and is no longer available. Refresh tmux_list or tmux_inspect; the old unread output may be unrecoverable. Do not fabricate a similar task id or keep reading the old one."
            )];
        case "tmux.capacityReached":
            return [errorHint(
                "tmux.capacityReached",
                "Managed pane capacity is reached. Reuse an existing pane or close finished panes; do not keep creating panes."
            )];
        case "tmux.paneBusy":
            return [errorHint(
                "tmux.paneBusy",
                "The pane already has a running task. Do not start a second task on the same pane or auto-set force; read or inspect the pane first, and force-close only if the user explicitly wants to terminate the running task."
            )];
        case "tmux.paneNotReady":
            return [errorHint(
                "tmux.paneNotReady",
                "The pane is not ready. Refresh tmux_list or tmux_inspect and confirm the pane state before retrying."
            )];
        case "tmux.paneNotFound":
            return [errorHint(
                "tmux.paneNotFound",
                "The pane was not found. Refresh tmux_list and use a current pane; do not guess pane ids or names."
            )];
        case "tmux.paneNameExists":
            return [errorHint(
                "tmux.paneNameExists",
                "A pane with that name already exists. Reuse the existing pane or choose a new name; do not silently rename the user's request."
            )];
        case "tmux.lastPane":
            return [errorHint(
                "tmux.lastPane",
                "The last managed pane cannot be closed. Keep or reuse it; do not bypass this protection."
            )];
        case "tmux.invalidCwd":
            return [errorHint(
                "tmux.invalidCwd",
                "The working directory is invalid. Confirm the cwd; do not create or guess paths."
            )];
        case "tmux.invalidInput":
        case "tmux.invalidFormat":
            return [errorHint(
                body.code,
                "The input encoding is invalid. Fix the input; do not guess control-key sequences or resend a previous batch that may already have been delivered."
            )];
        case "tmux.invalidPaneName":
            return [errorHint(
                "tmux.invalidPaneName",
                "The pane name is invalid. Use a name matching the allowed pattern."
            )];
        case "tmux.requestIdConflict":
            return [errorHint(
                "tmux.requestIdConflict",
                "The same ctxId/operationId was reused with different parameters. Generate a fresh request id; do not modify the replay cache to bypass this."
            )];
        case "tmux.startFailed":
        case "tmux.createFailed":
            return [errorHint(
                body.code,
                "The tmux operation failed to start. Refresh tmux_list and check the tmux runtime; do not assume the pane or task was created."
            )];
        case "tmux.unavailable":
            return [errorHint(
                "tmux.unavailable",
                "The tmux runtime is unavailable. Check the installation and environment; do not fall back to bash while claiming interactive tmux semantics."
            )];
        case "tmux.commandFailed":
            return [errorHint(
                "tmux.commandFailed",
                "A tmux backend command failed. Inspect the tmux server state and retry; do not assume the requested change took effect."
            )];
        case "tmux.runtimeConflict":
            return [errorHint(
                "tmux.runtimeConflict",
                "A conflicting tmux runtime state was detected. Inspect the tmux server and resolve the conflict; do not retry blindly."
            )];
        case "tmux.storageFailed":
            return [errorHint(
                "tmux.storageFailed",
                "Persisting tmux state failed. Retry the operation; if it persists, inspect worker storage."
            )];
        case "tmux.internalError":
        case "tmux.gcFailed":
            return [errorHint(
                body.code,
                "The tmux subsystem hit an internal error. Inspect the worker state before retrying; do not report completion."
            )];
        case "tool.cancelled":
            return [errorHint(
                "tool.cancelled",
                toolName === "tmux_run" || toolName === "tmux_input" || toolName === "tmux_read"
                    ? "The wait was cancelled, not the task; the task keeps running under its existing id. Continue observing the same task; do not start a duplicate, and terminate it only via pane/task state with explicit user authorization."
                    : "The tmux call was cancelled before completing. It has no lasting side effect; retry if the result is still needed."
            )];
        default:
            return workerCommonErrorHints(body);
    }
}
