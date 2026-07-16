import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import { getErrorCode } from "../WorkerInstanceError.js";

export function readNonRunningSchedulerStatus(errorCode: string): "queueTimeout" | "cancelled" | undefined {
    if (errorCode === errorCodes.coreToolQueueTimeout) {
        return "queueTimeout";
    }

    if (errorCode === errorCodes.coreToolCallCancelled || errorCode === "tool.cancelled") {
        return "cancelled";
    }

    return undefined;
}

export function normalizeToolSchedulerError(error: unknown): unknown {
    const errorCode = getErrorCode(error, errorCodes.coreProviderFailed);

    if (
        errorCode !== errorCodes.coreToolSchedulerFull &&
        errorCode !== errorCodes.coreToolQueueTimeout &&
        errorCode !== errorCodes.coreToolCallCancelled &&
        errorCode !== "tool.cancelled"
    ) {
        return error;
    }

    return createError({
        code: errorCode === "tool.cancelled" ? errorCodes.coreToolCallCancelled : errorCode,
        cause: error,
        message: error instanceof Error ? error.message : "Tool scheduler rejected the tool call.",
        retryable: true,
        details: readErrorDetails(error)
    });
}

export function throwIfToolCallAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) {
        return;
    }

    throw createError({
        code: errorCodes.coreToolCallCancelled,
        cause: signal.reason,
        message: "Tool call was cancelled by the client.",
        retryable: true,
        details: {
            reason: typeof signal.reason === "string" ? signal.reason : "client cancelled"
        }
    });
}

function readErrorDetails(error: unknown): JsonValue {
    if (typeof error !== "object" || error === null || Array.isArray(error) || !("details" in error)) {
        return {};
    }

    const details = (error as { details?: unknown }).details;
    return details === undefined ? {} : (details as JsonValue);
}
