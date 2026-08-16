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
            "Command timed out; use tmux_run for long tasks."
        ));
    } else if (termination === "signaled") {
        hints.push(errorHint(
            "bash.signaled",
            `Terminated by signal ${termSignal ?? "unknown"}; inspect output.`
        ));
    } else if (termination === "exited" && exitCode !== undefined && exitCode !== 0) {
        hints.push(errorHint(
            "bash.nonZeroExit",
            `Exited with code ${exitCode}; inspect output.`
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
        hints.push(diagnosticHint(
            "bash.outputTruncated",
            hasArtifact
                ? `Read full ${streams} with artifact_read.`
                : `${streams} output is incomplete.`
        ));
    }

    const warnings = asArray(record.artifactWarnings);
    if (warnings !== undefined && warnings.length > 0) {
        hints.push(diagnosticHint(
            "bash.artifactWarning",
            "Full output may not be stored."
        ));
    }

    return hints;
}

export function bashErrorHints(body: ControlErrorBody): ToolDiagnosticHint[] {
    switch (body.code) {
        case "bash.invalidCommand":
            return [errorHint(
                "bash.invalidCommand",
                "Provide one non-empty command line."
            )];
        case "bash.invalidCwd":
            return [errorHint(
                "bash.invalidCwd",
                "Use ./ for a workspace-relative cwd or / for an absolute cwd."
            )];
        case "bash.spawnFailed":
            return [errorHint(
                "bash.spawnFailed",
                "Check the shell runtime."
            )];
        case "bash.shellUnavailable":
            return [errorHint(
                "bash.shellUnavailable",
                "Verify the shell installation."
            )];
        case "bash.ioFailed":
            return [errorHint(
                "bash.ioFailed",
                "Inspect process I/O state."
            )];
        case "tool.cancelled":
            return [errorHint(
                "tool.cancelled",
                "Cancelled; inspect output and possible side effects."
            )];
        default:
            return workerCommonErrorHints(body);
    }
}
