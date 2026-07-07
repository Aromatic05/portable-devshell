export interface CommandResult {
    exitCode: number | null;
    signal?: string;
    stderr: string;
    stdout: string;
    timedOut?: boolean;
}
