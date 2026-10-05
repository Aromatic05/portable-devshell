import {
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type RemoteErrorBody,
} from "@portable-devshell/shared";


export function readNonRunningSchedulerStatus(
    errorCode: string,
): "queueTimeout" | "cancelled" | undefined {
    if (errorCode === runtimeErrorCodes.toolQueueTimeout) {
        return "queueTimeout";
    }

    if (
        errorCode === runtimeErrorCodes.toolCallCancelled ||
        errorCode === "tool.cancelled"
    ) {
        return "cancelled";
    }

    return undefined;
}

export function normalizeToolSchedulerError(error: unknown): unknown {
    const errorCode = getErrorCode(error, runtimeErrorCodes.providerFailed);

    if (
        errorCode !== runtimeErrorCodes.toolSchedulerFull &&
        errorCode !== runtimeErrorCodes.toolQueueTimeout &&
        errorCode !== runtimeErrorCodes.toolCallCancelled &&
        errorCode !== "tool.cancelled"
    ) {
        return error;
    }

    return createRemoteError({
        code:
            errorCode === "tool.cancelled"
                ? runtimeErrorCodes.toolCallCancelled
                : errorCode,
        cause: error,
        message:
            error instanceof Error
                ? error.message
                : "Tool scheduler rejected the tool call.",
        retryable: true,
        details: readErrorDetails(error),
    });
}

function readErrorDetails(error: unknown): JsonValue {
    if (
        typeof error !== "object" ||
        error === null ||
        Array.isArray(error) ||
        !("details" in error)
    ) {
        return {};
    }

    const details = (error as { details?: unknown }).details;
    return details === undefined ? {} : (details as JsonValue);
}

export function throwIfToolCallAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) {
        return;
    }

    throw createRemoteError({
        code: runtimeErrorCodes.toolCallCancelled,
        cause: signal.reason,
        message: "Tool call was cancelled by the client.",
        retryable: true,
        details: {
            reason:
                typeof signal.reason === "string"
                    ? signal.reason
                    : "client cancelled",
        },
    });
}

export function createErrorFromBody(body: RemoteErrorBody): Error {
    return createRemoteError({
        code: body.code,
        ...(body.cause === undefined
            ? {}
            : { cause: createErrorFromBody(body.cause) }),
        ...(body.details === undefined ? {} : { details: body.details }),
        message: body.message,
        retryable: body.retryable,
    });
}

export function getErrorCode(error: unknown, fallback: string): string {
    if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
    ) {
        return error.code;
    }

    return fallback;
}

