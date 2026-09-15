import type { JsonValue } from "./JsonValue.js";

export interface CommandDiagnostic extends Record<
    string,
    JsonValue | undefined
> {
    causeCode?: string;
    causeMessage?: string;
    command?: string[];
    commandDisplay?: string;
    cwd?: string;
    exitCode?: number | null;
    instance?: string;
    operation?: string;
    provider?: string;
    signal?: string;
    stderrTail?: string;
    stdoutTail?: string;
}

export interface CommandResult {
    exitCode: number | null;
    details?: CommandDiagnostic;
    signal?: string;
    stderr: string;
    stdout: string;
    timedOut?: boolean;
}
