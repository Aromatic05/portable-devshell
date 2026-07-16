import { createError, errorCodes } from "@portable-devshell/shared";

export function throwIfMcpEndpointAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw mcpEndpointCancellationError(signal.reason);
    }
}

export async function waitForMcpEndpointAbortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    throwIfMcpEndpointAborted(signal);
    if (signal === undefined) {
        return await operation;
    }
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(mcpEndpointCancellationError(signal.reason));
        signal.addEventListener("abort", onAbort, { once: true });
        void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

function mcpEndpointCancellationError(reason: unknown) {
    return createError({
        code: errorCodes.coreToolCallCancelled,
        cause: reason,
        message: "MCP tool call was cancelled by the client.",
        retryable: true,
        details: { reason: typeof reason === "string" ? reason : "client cancelled" }
    });
}
