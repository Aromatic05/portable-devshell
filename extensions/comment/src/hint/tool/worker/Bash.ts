import type { RemoteErrorBody } from "@portable-devshell/shared";
import type { JsonValue } from "@portable-devshell/shared";
import {
    asArray,
    asBoolean,
    asNumber,
    asRecord,
    asString,
} from "../Value.js";
import {
    diagnosticHint,
    errorHint,
    type ToolDiagnosticHint,
} from "../../Hint.js";
import { workerErrorHints } from "../Error.js";

export function bashResultHints(
    result: JsonValue,
    instance?: string,
): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const hints: ToolDiagnosticHint[] = [];

    const termination = asString(record.termination);
    const exitCode = asNumber(record.exitCode);
    const termSignal = asNumber(record.termSignal);

    if (asBoolean(record.detached) === true) {
        hints.push(diagnosticHint(
            "bash.waitDetached",
            "The synchronous wait window ended. The process is still running; continue with task_input (omit input to poll) using the returned task ID and cursor.",
        ));
    } else if (termination === "timeout" || asBoolean(record.timedOut) === true) {
        hints.push(
            errorHint(
                "bash.timeout",
                "The command timed out. Use waitMs to return while a long task keeps running, then continue with task_input.",
            ),
        );
    } else if (termination === "running") {
        const task = asRecord(record.task);
        if (asBoolean(task?.humanControl) === true) {
            hints.push(
                diagnosticHint(
                    "bash.humanControl",
                    "A human currently controls this terminal; do not send model input until control is released. You may continue read-only polling (task_input without input) or screen inspection (task_inspect).",
                ),
            );
        } else {
            const taskId = asString(task?.id);
            const attachGuidance =
                asBoolean(task?.pty) === true &&
                instance !== undefined &&
                taskId !== undefined
                    ? ` If human intervention is needed, tell the user to run: devshell terminal attach ${instance} ${taskId} --takeover (or open TUI Sessions).`
                    : "";
            hints.push(
                diagnosticHint(
                    "bash.taskRunning",
                    `Continue with task_input (omit input to poll) using the returned task ID and cursor, or stop it with task_manage(command: "close", task); the process is still running.${attachGuidance}`,
                ),
            );
            if (asBoolean(task?.alternateScreen) === true) {
                hints.push(
                    diagnosticHint(
                        "bash.alternateScreen",
                        "This PTY is currently in alternate-screen mode (full-screen TUI). Use task_inspect to view the clean rendered screen instead of parsing raw ANSI output.",
                    ),
                );
            }
        }
    } else if (termination === "signaled") {
        hints.push(
            errorHint(
                "bash.signaled",
                `Terminated by signal ${termSignal ?? "unknown"}; inspect output.`,
            ),
        );
    } else if (
        termination === "exited" &&
        exitCode !== undefined &&
        exitCode !== 0
    ) {
        hints.push(
            errorHint(
                "bash.nonZeroExit",
                `Exited with code ${exitCode}; inspect output.`,
            ),
        );
    }

    const stdoutTruncated = asBoolean(record.stdoutTruncated) === true;
    const stderrTruncated = asBoolean(record.stderrTruncated) === true;
    if (stdoutTruncated || stderrTruncated) {
        const streams = [
            ...(stdoutTruncated ? ["stdout"] : []),
            ...(stderrTruncated ? ["stderr"] : []),
        ].join(" and ");
        hints.push(
            diagnosticHint(
                "bash.outputTruncated",
                `${streams} output is incomplete.`,
            ),
        );
    }

    const warnings = asArray(record.artifactWarnings);
    if (warnings !== undefined && warnings.length > 0) {
        hints.push(
            diagnosticHint(
                "bash.artifactWarning",
                "Full output may not be stored.",
            ),
        );
    }

    return hints;
}

export function bashErrorHints(body: RemoteErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "bash.invalidCommand":
            return [
                errorHint(
                    "bash.invalidCommand",
                    "Provide one non-empty command line.",
                ),
            ];
        case "bash.invalidCwd":
            return [
                errorHint(
                    "bash.invalidCwd",
                    "Use a workspace-relative or absolute directory path.",
                ),
            ];
        case "bash.spawnFailed":
            return [errorHint("bash.spawnFailed", "Check the shell runtime.")];
        case "bash.shellUnavailable":
            return [
                errorHint(
                    "bash.shellUnavailable",
                    "Verify the shell installation.",
                ),
            ];
        case "tool.cancelled":
            return [
                errorHint(
                    "tool.cancelled",
                    "Cancelled; inspect output and possible side effects.",
                ),
            ];
        default:
            return workerErrorHints(body);
    }
}
