export const cliExitCodes = {
    controlNotRunning: 3,
    failure: 1,
    instanceNotFound: 4,
    success: 0,
    usage: 2
} as const;

export type CliExitCode = (typeof cliExitCodes)[keyof typeof cliExitCodes];
