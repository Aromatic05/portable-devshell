import type { ChildProcess } from "node:child_process";

import type { CommandResult, ControlError } from "@portable-devshell/shared";

import type { ProviderCommandContext, WorkerCommandResult } from "../../command/WorkerCommandTransport.js";

export async function waitForCommandResult(
    child: ChildProcess,
    createProviderError: (
        context: ProviderCommandContext,
        cause: unknown,
        options?: { errorCode?: string; result?: Partial<CommandResult> }
    ) => ControlError,
    context: ProviderCommandContext
): Promise<WorkerCommandResult> {
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
    });

    return await new Promise<WorkerCommandResult>((resolve, reject) => {
        child.once("error", (error) => {
            reject(createProviderError(context, error, { result: { stderr, stdout } }));
        });
        child.once("close", (code, signal) => {
            resolve({
                details: {
                    command: [...context.command],
                    commandDisplay: context.commandDisplay,
                    ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
                    ...(context.instance === undefined ? {} : { instance: context.instance }),
                    operation: context.operation,
                    provider: context.provider,
                    ...(signal === null ? {} : { signal }),
                    ...(stderr.length === 0 ? {} : { stderrTail: tail(stderr) }),
                    ...(stdout.length === 0 ? {} : { stdoutTail: tail(stdout) }),
                    exitCode: code
                },
                exitCode: code,
                signal: signal ?? undefined,
                stderr,
                stdout
            });
        });
    });
}

const COMMAND_OUTPUT_TAIL_LIMIT = 4000;

function tail(value: string): string {
    return value.length <= COMMAND_OUTPUT_TAIL_LIMIT ? value : value.slice(-COMMAND_OUTPUT_TAIL_LIMIT);
}
