import { createError, type CommandResult, errorCodes, type ControlError } from "@portable-devshell/shared";

import type { ProviderCommandContext } from "../command/WorkerCommandTransport.js";
import type { WorkerTarget } from "./WorkerTarget.js";
import { mapNodeWorkerTarget, mapUnameWorkerTarget } from "./WorkerTargetMapper.js";

const COMMAND_OUTPUT_TAIL_LIMIT = 4000;

export interface WorkerTargetProbe {
    probe(): Promise<WorkerTarget>;
}

export const workerTargetProbeCommandLine = `printf '%s\n%s\n' "$(uname -s)" "$(uname -m)"`;

export function probeLocalWorkerTarget(
    provider: string = "local",
    operation: string = "resolveExecutable",
    platform: string = process.platform,
    arch: string = process.arch
): WorkerTarget {
    return mapNodeWorkerTarget({
        provider,
        operation,
        platform,
        arch
    });
}

export function parseWorkerTargetProbeOutput(context: ProviderCommandContext, stdout: string): WorkerTarget {
    const normalizedOutput = stdout.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const [rawOs = "", rawArch = ""] = normalizedOutput.split("\n");

    return mapUnameWorkerTarget({
        provider: context.provider,
        operation: context.operation,
        rawArch,
        rawOs
    });
}

export function createWorkerTargetProbeFailedError(
    context: ProviderCommandContext,
    input: {
        cause?: unknown;
        result?: Partial<CommandResult>;
    } = {}
): ControlError {
    return createError({
        code: errorCodes.coreWorkerTargetProbeFailed,
        cause: input.cause,
        details: {
            commandDisplay: context.commandDisplay,
            ...(typeof input.result?.exitCode === "number" || input.result?.exitCode === null ? { exitCode: input.result.exitCode } : {}),
            operation: context.operation,
            provider: context.provider,
            ...(typeof input.result?.stderr === "string" && input.result.stderr.length > 0 ? { stderrTail: tail(input.result.stderr) } : {}),
            ...(typeof input.result?.stdout === "string" && input.result.stdout.length > 0 ? { stdoutTail: tail(input.result.stdout) } : {})
        },
        message: `Worker target probe failed for provider ${context.provider}.`,
        retryable: false
    });
}

function tail(value: string): string {
    return value.length <= COMMAND_OUTPUT_TAIL_LIMIT ? value : value.slice(-COMMAND_OUTPUT_TAIL_LIMIT);
}
