import {
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
} from "@portable-devshell/shared";

import { getErrorCode } from "../state/Error.js";

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
