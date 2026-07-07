import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { WorkerRpcProcess } from "../WorkerProcess.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "./WorkerCommandOptions.js";

export interface WorkerCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface WorkerCommandTransport {
    runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions): Promise<WorkerCommandResult>;
    spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess>;
    installWorker(): Promise<void>;
}

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export const providerFailedErrorCode = "core.providerFailed";

export async function waitForCommandResult(
    child: ChildProcess,
    createError: (operation: string, cause: unknown) => Error,
    operation: string
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
            reject(createError(operation, error));
        });
        child.once("close", (code) => {
            resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
    });
}

export function createProviderError(provider: string, operation: string, cause: unknown, details: Record<string, string>): Error {
    const detailMessage = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`${provider} provider failed to ${operation}`);

    Object.assign(error, {
        code: providerFailedErrorCode,
        details: { provider, cause: detailMessage, ...details },
        retryable: false
    });

    return error;
}
