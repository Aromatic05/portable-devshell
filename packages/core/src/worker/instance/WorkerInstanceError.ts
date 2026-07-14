import { createError, errorCodes, type CommandDiagnostic, type JsonValue } from "@portable-devshell/shared";

export function getErrorCode(error: unknown, fallback: string): string {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
        return error.code;
    }

    return fallback;
}

export function readReverseErrorMessage(error: unknown): string {
    if (typeof error === "object" && error !== null && "details" in error) {
        const details = error.details;
        if (typeof details === "object" && details !== null && !Array.isArray(details)) {
            const causeMessage = (details as Record<string, unknown>).causeMessage;
            if (typeof causeMessage === "string" && causeMessage.length > 0) {
                return causeMessage;
            }
        }
    }
    return error instanceof Error ? error.message : String(error);
}

export function isKnownErrorCode(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

export function withInstanceDetails(details: CommandDiagnostic | undefined, instance: string): CommandDiagnostic {
    return {
        ...(details ?? {}),
        instance
    };
}

export function wrapWorkerCommandError(error: unknown, code: string, message: string, instance: string): unknown {
    if (
        !isKnownErrorCode(error) ||
        getErrorCode(error, code) === code ||
        getErrorCode(error, code) !== errorCodes.coreProviderFailed
    ) {
        return error;
    }

    return createError({
        code,
        cause: error,
        message,
        retryable: false,
        details: toJsonDetails(withInstanceDetails(readCommandDiagnostic((error as { details?: unknown }).details), instance))
    });
}

export function toJsonDetails(details: CommandDiagnostic): JsonValue {
    return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) as JsonValue;
}

export function readCommandDiagnostic(value: unknown): CommandDiagnostic | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;

    return {
        ...(typeof candidate.causeCode === "string" ? { causeCode: candidate.causeCode } : {}),
        ...(typeof candidate.causeMessage === "string" ? { causeMessage: candidate.causeMessage } : {}),
        ...(Array.isArray(candidate.command) ? { command: candidate.command.filter((entry): entry is string => typeof entry === "string") } : {}),
        ...(typeof candidate.commandDisplay === "string" ? { commandDisplay: candidate.commandDisplay } : {}),
        ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
        ...(typeof candidate.exitCode === "number" || candidate.exitCode === null ? { exitCode: candidate.exitCode as number | null } : {}),
        ...(typeof candidate.instance === "string" ? { instance: candidate.instance } : {}),
        ...(typeof candidate.operation === "string" ? { operation: candidate.operation } : {}),
        ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
        ...(typeof candidate.signal === "string" ? { signal: candidate.signal } : {}),
        ...(typeof candidate.stderrTail === "string" ? { stderrTail: candidate.stderrTail } : {}),
        ...(typeof candidate.stdoutTail === "string" ? { stdoutTail: candidate.stdoutTail } : {})
    };
}
