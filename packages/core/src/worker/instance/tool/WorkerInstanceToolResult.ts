import type { CommandResult, JsonValue } from "@portable-devshell/shared";

import { readCommandDiagnostic } from "../WorkerInstanceError.js";
import { toEventData } from "../WorkerInstanceEvent.js";

export interface WorkerInstanceBashToolResult {
    exitCode?: number | null;
    stderr: string;
    stderrBytes: number;
    stdout: string;
    stdoutBytes: number;
    termSignal?: number;
    termination?: "exited" | "signaled" | "timeout";
}

export function asCommandResult(error: unknown): CommandResult | undefined {
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
        return undefined;
    }

    const candidate = error as Record<string, unknown>;
    if (
        typeof candidate.stdout === "string" &&
        typeof candidate.stderr === "string" &&
        (typeof candidate.exitCode === "number" || candidate.exitCode === null)
    ) {
        return {
            details: readCommandDiagnostic(candidate.details),
            exitCode: candidate.exitCode as number | null,
            signal: typeof candidate.signal === "string" ? candidate.signal : undefined,
            stderr: candidate.stderr,
            stdout: candidate.stdout,
            timedOut: candidate.timedOut === true
        };
    }

    const details = readCommandDiagnostic(candidate.details);
    if (details === undefined || (typeof details.exitCode !== "number" && details.exitCode !== null)) {
        return undefined;
    }

    return {
        details,
        exitCode: details.exitCode ?? null,
        signal: details.signal,
        stderr: "",
        stdout: "",
        timedOut: candidate.timedOut === true
    };
}

export function commandResultOutput(result: CommandResult): JsonValue {
    return toEventData({
        details: result.details as unknown as JsonValue | undefined,
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut
    });
}

export function asBashToolResult(value: JsonValue): WorkerInstanceBashToolResult | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const result = value as Record<string, JsonValue>;
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
        return undefined;
    }

    const termination = result.termination;
    return {
        ...(typeof result.exitCode === "number" || result.exitCode === null ? { exitCode: result.exitCode } : {}),
        stderr: result.stderr,
        stderrBytes: typeof result.stderrBytes === "number" ? result.stderrBytes : readByteLength(result.stderr),
        stdout: result.stdout,
        stdoutBytes: typeof result.stdoutBytes === "number" ? result.stdoutBytes : readByteLength(result.stdout),
        ...(typeof result.termSignal === "number" ? { termSignal: result.termSignal } : {}),
        ...(termination === "exited" || termination === "signaled" || termination === "timeout" ? { termination } : {})
    };
}

export function readByteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}
