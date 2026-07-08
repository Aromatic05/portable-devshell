import type { ChildProcess, SpawnOptions } from "node:child_process";

import { createError, errorCodes, type CommandDiagnostic, type CommandResult, type ControlError, type JsonValue } from "@portable-devshell/shared";

import type { WorkerRpcProcess } from "../WorkerProcess.js";
import type { WorkerCommandName, WorkerCommandOptions, WorkerRpcOptions } from "./WorkerCommandOptions.js";

export type WorkerCommandResult = CommandResult;

export interface ProviderCommandContext extends CommandDiagnostic {
    command: string[];
    commandDisplay: string;
    instance?: string;
    operation: string;
    provider: string;
}

export interface WorkerCommandTransport {
    runWorkerCommand(command: WorkerCommandName, options: WorkerCommandOptions): Promise<WorkerCommandResult>;
    spawnWorkerRpc(options: WorkerRpcOptions): Promise<WorkerRpcProcess>;
    installWorker(): Promise<void>;
}

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export const providerFailedErrorCode = "core.providerFailed";
const COMMAND_OUTPUT_TAIL_LIMIT = 4000;

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
                details: buildCommandDiagnostic(context, {
                    exitCode: code,
                    signal: signal ?? undefined,
                    stderr,
                    stdout
                }),
                exitCode: code,
                signal: signal ?? undefined,
                stderr,
                stdout
            });
        });
    });
}

export function createProviderError(
    context: ProviderCommandContext,
    cause: unknown,
    options: { errorCode?: string; result?: Partial<CommandResult> } = {}
): ControlError {
    const details = buildCommandDiagnostic(context, options.result, cause);

    return createError({
        code: options.errorCode ?? errorCodes.coreProviderFailed,
        cause,
        details: toJsonDetails(details),
        message: `${context.provider} provider failed to ${context.operation}.`,
        retryable: false
    });
}

export function createCommandContext(input: {
    provider: string;
    operation: string;
    command: readonly string[];
    cwd?: string;
    instance?: string;
}): ProviderCommandContext {
    return {
        command: [...input.command],
        commandDisplay: formatCommandDisplay(input.command),
        cwd: input.cwd,
        instance: input.instance,
        operation: input.operation,
        provider: input.provider
    };
}

function buildCommandDiagnostic(
    context: ProviderCommandContext,
    result: Partial<CommandResult> = {},
    cause?: unknown
): CommandDiagnostic {
    return {
        ...(readCauseCode(cause) === undefined ? {} : { causeCode: readCauseCode(cause) }),
        ...(readCauseMessage(cause) === undefined ? {} : { causeMessage: readCauseMessage(cause) }),
        command: [...context.command],
        commandDisplay: context.commandDisplay,
        ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
        ...(context.instance === undefined ? {} : { instance: context.instance }),
        operation: context.operation,
        provider: context.provider,
        ...(typeof result.signal === "string" ? { signal: result.signal } : {}),
        ...(typeof result.stderr === "string" && result.stderr.length > 0 ? { stderrTail: tail(result.stderr) } : {}),
        ...(typeof result.stdout === "string" && result.stdout.length > 0 ? { stdoutTail: tail(result.stdout) } : {}),
        ...(typeof result.exitCode === "number" || result.exitCode === null ? { exitCode: result.exitCode } : {})
    };
}

function formatCommandDisplay(command: readonly string[]): string {
    return command
        .map((segment) => (/^[A-Za-z0-9_./:@=-]+$/u.test(segment) ? segment : JSON.stringify(segment)))
        .join(" ");
}

function readCauseCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function readCauseMessage(error: unknown): string | undefined {
    if (error instanceof Error) {
        return error.message;
    }

    return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : undefined;
}

function tail(value: string): string {
    return value.length <= COMMAND_OUTPUT_TAIL_LIMIT ? value : value.slice(-COMMAND_OUTPUT_TAIL_LIMIT);
}

function toJsonDetails(details: CommandDiagnostic): JsonValue {
    return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as JsonValue;
}
