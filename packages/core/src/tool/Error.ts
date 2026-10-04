import {
    createRemoteError,
    runtimeErrorCodes,
    type RemoteErrorBody,
} from "@portable-devshell/shared";

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
