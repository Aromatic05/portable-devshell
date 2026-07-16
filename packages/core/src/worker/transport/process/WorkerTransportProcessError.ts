import { createError, errorCodes, type CommandDiagnostic, type CommandResult, type ControlError, type JsonValue } from "@portable-devshell/shared";

import type { ProviderCommandContext } from "../../command/WorkerCommandTransport.js";

const COMMAND_OUTPUT_TAIL_LIMIT = 4000;

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
    return command.map(formatCommandDisplaySegment).join(" ");
}

function formatCommandDisplaySegment(segment: string): string {
    if (/^[A-Za-z0-9_./:@=-]+$/u.test(segment)) {
        return segment;
    }

    return /^'(?:[^']|'\\'')*'$/u.test(segment) ? segment : `'${segment.replaceAll("'", `'\\''`)}'`;
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
