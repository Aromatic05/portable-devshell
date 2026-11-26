import type { RemoteErrorBody } from "@portable-devshell/shared";
import { errorHint, type ToolDiagnosticHint } from "../../Hint.js";

const processErrors: Readonly<Record<string, string>> = {
    "process.hostFailed": "The Process Host is unavailable. Inspect the Worker and retry after it is ready.",
    "process.notFound": "The task does not exist in this execution scope. Check its task ID and workspace.",
    "process.notTerminal": "This resource has no PTY. Use task_input without input to read non-PTY output.",
    "process.notPipe": "This resource is a PTY, not a pipe. Send terminal input via task_input.",
    "process.stdinClosed": "The process input stream is closed. Start a new command with pty: true if interactive input is required.",
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
