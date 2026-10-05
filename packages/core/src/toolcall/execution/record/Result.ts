import type { CommandDiagnostic, CommandResult, JsonValue } from "@portable-devshell/shared";

import { toEventData } from "./Event.js";

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
            signal:
                typeof candidate.signal === "string"
                    ? candidate.signal
                    : undefined,
            stderr: candidate.stderr,
            stdout: candidate.stdout,
            timedOut: candidate.timedOut === true,
        };
    }

    const details = readCommandDiagnostic(candidate.details);
    if (
        details === undefined ||
        (typeof details.exitCode !== "number" && details.exitCode !== null)
    ) {
        return undefined;
    }

    return {
        details,
        exitCode: details.exitCode ?? null,
        signal: details.signal,
        stderr: "",
        stdout: "",
        timedOut: candidate.timedOut === true,
    };
}

export function commandResultOutput(result: CommandResult): JsonValue {
    return toEventData({
        details: result.details as unknown as JsonValue | undefined,
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
    });
}

export function stripCommandStreams(value: JsonValue): JsonValue {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return value;
    }
    const {
        stderr: _stderr,
        stdout: _stdout,
        ...rest
    } = value as Record<string, JsonValue>;
    return rest;
}

export function asBashToolResult(
    value: JsonValue,
): WorkerInstanceBashToolResult | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const result = value as Record<string, JsonValue>;
    if (
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string"
    ) {
        return undefined;
    }

    const termination = result.termination;
    return {
        ...(typeof result.exitCode === "number" || result.exitCode === null
            ? { exitCode: result.exitCode }
            : {}),
        stderr: result.stderr,
        stderrBytes:
            typeof result.stderrBytes === "number"
                ? result.stderrBytes
                : readByteLength(result.stderr),
        stdout: result.stdout,
        stdoutBytes:
            typeof result.stdoutBytes === "number"
                ? result.stdoutBytes
                : readByteLength(result.stdout),
        ...(typeof result.termSignal === "number"
            ? { termSignal: result.termSignal }
            : {}),
        ...(termination === "exited" ||
        termination === "signaled" ||
        termination === "timeout"
            ? { termination }
            : {}),
    };
}

export function readByteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

export function readCommandDiagnostic(
    value: unknown,
): CommandDiagnostic | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;

    return {
        ...(typeof candidate.causeCode === "string"
            ? { causeCode: candidate.causeCode }
            : {}),
        ...(typeof candidate.causeMessage === "string"
            ? { causeMessage: candidate.causeMessage }
            : {}),
        ...(Array.isArray(candidate.command)
            ? {
                  command: candidate.command.filter(
                      (entry): entry is string => typeof entry === "string",
                  ),
              }
            : {}),
        ...(typeof candidate.commandDisplay === "string"
            ? { commandDisplay: candidate.commandDisplay }
            : {}),
        ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
        ...(typeof candidate.exitCode === "number" ||
        candidate.exitCode === null
            ? { exitCode: candidate.exitCode as number | null }
            : {}),
        ...(typeof candidate.instance === "string"
            ? { instance: candidate.instance }
            : {}),
        ...(typeof candidate.operation === "string"
            ? { operation: candidate.operation }
            : {}),
        ...(typeof candidate.provider === "string"
            ? { provider: candidate.provider }
            : {}),
        ...(typeof candidate.signal === "string"
            ? { signal: candidate.signal }
            : {}),
        ...(typeof candidate.stderrTail === "string"
            ? { stderrTail: candidate.stderrTail }
            : {}),
        ...(typeof candidate.stdoutTail === "string"
            ? { stdoutTail: candidate.stdoutTail }
            : {}),
    };
}
