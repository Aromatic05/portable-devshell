import type { JsonValue, RemoteErrorBody } from "@portable-devshell/shared";
import { diagnosticHint, errorHint, type ToolDiagnosticHint } from "../../Hint.js";
import { asBoolean, asRecord, asString } from "../Value.js";

const processErrors: Readonly<Record<string, string>> = {
    "process.hostFailed": "The Process Host is unavailable. Inspect the Worker and retry after it is ready.",
    "process.taskFailed": "The target process failed. Inspect its state and retained output; do not restart the Process Host.",
    "process.notFound": "The task does not exist in this execution scope. Check its task ID and workspace.",
    "process.notTerminal": "This resource has no PTY. Use task_input without input to read non-PTY output.",
    "process.notPipe": "This resource is a PTY, not a pipe. Send terminal input via task_input.",
    "process.exited": "The target process has already exited. Omit input in task_input to read retained output, or start a new command with bash_run.",
    "process.stdinClosed": "The process input stream is closed (either the task is non-PTY or has already exited). Omit input in task_input to read retained output, use task_manage(command: \"close\", task) to stop a running non-PTY task, or start a new command with pty: true if interactive input is required.",
    "process.inputBusy": "The input queue is full. Wait for the process to consume input before retrying.",
    "process.captureFailed": "Process output capture failed. Inspect the process and Worker storage state.",
    "process.resourceLimit": "The Process Host has no free resource slots. Finish or close an existing process before starting another.",
    "process.retiring": "The Process Host is retiring. Wait for the Instance lifecycle operation to finish.",
    "process.staleGeneration": "The Process Host generation changed. Rediscover the task before continuing.",
    "process.controlOwned": "A human currently owns terminal input. Do not send model input until that control lease is released.",
    "process.resizeFailed": "The terminal could not be resized. Inspect its current state before retrying.",
    "process.killFailed": "The process could not be terminated. Inspect its current state before retrying.",
    "process.ioFailed": "Process I/O failed. Inspect the process state and retained output.",
    "process.internal": "The Process Host reported an internal error. Inspect the Worker audit and retry only after the cause is known.",
};

export function processErrorHints(body: RemoteErrorBody): ToolDiagnosticHint[] {
    const message = processErrors[body.code];
    return message === undefined ? [] : [errorHint(body.code, message)];
}

export function taskErrorHints(body: RemoteErrorBody): ToolDiagnosticHint[] {
    if (body.code === "tool.cancelled") {
        return [
            errorHint(
                "tool.cancelled",
                "Cancelled; inspect task state and retained output before retrying.",
            ),
        ];
    }
    return processErrorHints(body);
}

export function taskManageResultHints(
    result: JsonValue,
    instance?: string,
): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    if (asBoolean(record.killRequested) === true && asString(record.state) === "running") {
        return [
            diagnosticHint(
                "process.closePending",
                "Termination was requested, but the task is still running. Poll task_manage(command: \"list\") until its state leaves running.",
            ),
        ];
    }
    const task = asRecord(record.task);
    const id = task === undefined ? undefined : asString(task.id);
    if (task !== undefined && id !== undefined) {
        const target = asString(task.name) ?? id;
        const attachCmd = instance
            ? `devshell terminal attach ${instance} ${target} --takeover`
            : `devshell terminal attach <instance> ${target} --takeover`;
        return [
            diagnosticHint(
                "process.terminalCreated",
                `Persistent terminal ready. If human intervention (e.g. login/MFA) is needed, tell the user to run: ${attachCmd} (or open TUI Sessions).`,
            ),
        ];
    }
    return [];
}
