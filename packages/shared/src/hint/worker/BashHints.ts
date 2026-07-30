import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import { asArray, asBoolean, asNumber, asRecord, asString } from "../JsonRead.js";
import { diagnosticHint, errorHint, type ToolDiagnosticHint } from "../ToolDiagnosticHint.js";
import { workerCommonErrorHints } from "./WorkerCommonHints.js";

export function bashResultHints(result: JsonValue): ToolDiagnosticHint[] {
    const record = asRecord(result);
    if (record === undefined) return [];
    const hints: ToolDiagnosticHint[] = [];

    const termination = asString(record.termination);
    const exitCode = asNumber(record.exitCode);
    const termSignal = asNumber(record.termSignal);

    if (termination === "timeout" || asBoolean(record.timedOut) === true) {
        hints.push(errorHint(
            "bash.timeout",
            "The command was killed because it exceeded its timeout, so its output may be incomplete and it is no longer running. If it was meant to be long-running or interactive, use tmux_run; otherwise investigate the blocking point first. Do not treat this as success or retry unchanged with the same timeout."
        ));
    } else if (termination === "signaled") {
        hints.push(errorHint(
            "bash.signaled",
            `The command was terminated by signal ${termSignal ?? "unknown"} and did not complete. Inspect the signal and captured output, and determine whether it came from a resource limit, an external kill, or a crash before retrying. Do not treat this result as success.`
        ));
    } else if (termination === "exited" && exitCode !== undefined && exitCode !== 0) {
        hints.push(errorHint(
            "bash.nonZeroExit",
            `The command ran but exited with code ${exitCode}. Inspect the original stdout and stderr, then correct the command, dependencies, input, or environment before calling again. Do not report completion or retry the same command unchanged.`
        ));
    }

    const stdoutTruncated = asBoolean(record.stdoutTruncated) === true;
    const stderrTruncated = asBoolean(record.stderrTruncated) === true;
    if (stdoutTruncated || stderrTruncated) {
        const streams = [
            ...(stdoutTruncated ? ["stdout"] : []),
            ...(stderrTruncated ? ["stderr"] : [])
        ].join(" and ");
        const hasArtifact = asRecord(record.stdoutArtifact) !== undefined || asRecord(record.stderrArtifact) !== undefined;
        const tail = hasArtifact
            ? " Read the full stored output with artifact_read using the returned artifact handle; if that artifact is itself marked truncated, the missing bytes are unrecoverable."
            : " No full-output artifact is available, so the missing bytes are unrecoverable.";
        hints.push(diagnosticHint(
            "bash.outputTruncated",
            `The captured ${streams} output is incomplete.${tail} Do not claim to have seen the full log based on the captured tail.`
        ));
    }

    const warnings = asArray(record.artifactWarnings);
    if (warnings !== undefined && warnings.length > 0) {
        hints.push(diagnosticHint(
            "bash.artifactWarning",
            "Persisting the full-output artifact reported a problem, so the inline output may be only a truncated portion and the complete log may not be stored. Check the warnings and the captured output; do not claim the full log was saved."
        ));
    }

    return hints;
}

export function bashErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "bash.invalidCommand":
            return [errorHint(
                "bash.invalidCommand",
                "Provide a single non-empty command line. Do not auto-assemble or guess a command."
            )];
        case "bash.invalidCwd":
            return [errorHint(
                "bash.invalidCwd",
                "The working directory does not exist or is not a directory. Confirm the cwd before retrying; do not create or guess paths."
            )];
        case "bash.spawnFailed":
            return [errorHint(
                "bash.spawnFailed",
                "The shell process could not be spawned. Check that the shell runtime is available; do not treat this as a command exit code."
            )];
        case "bash.shellUnavailable":
            return [errorHint(
                "bash.shellUnavailable",
                "No usable shell runtime is available on the worker. Verify the shell installation and environment; do not retry unchanged."
            )];
        case "bash.ioFailed":
            return [errorHint(
                "bash.ioFailed",
                "Reading the process I/O failed, so there is no reliable complete result. Check the process I/O state; do not pretend a complete result exists."
            )];
        case "tool.cancelled":
            return [errorHint(
                "tool.cancelled",
                "The bash_run call was cancelled. If it was cancelled while running, the process group was terminated, but external side effects may already have occurred and existing output should still be checked. Do not keep waiting on the same process or report success."
            )];
        default:
            return workerCommonErrorHints(body);
    }
}
