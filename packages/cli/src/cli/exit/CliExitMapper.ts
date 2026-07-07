import { cliExitCodes, type CliExitCode } from "./CliExitCode.js";

export class CliExitMapper {
    map(error: unknown): CliExitCode {
        const code = readErrorCode(error);

        switch (code) {
            case "control.notRunning":
                return cliExitCodes.controlNotRunning;
            case "instance.missing":
                return cliExitCodes.instanceNotFound;
            case "cli.usage":
                return cliExitCodes.usage;
            default:
                return cliExitCodes.failure;
        }
    }
}

function readErrorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
}
