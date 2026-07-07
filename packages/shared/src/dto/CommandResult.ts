export interface CommandResult {
    exitCode: number;
    signal?: string;
    stderr: string;
    stdout: string;
}
