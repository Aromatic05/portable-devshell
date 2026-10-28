/** Each page has a deadline; abort also releases callers of unresponsive transports. */
export async function readHistoryPage<T>(
    read: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("History read timed out. Retry the operation.")), 30_000);
    let rejectAbort: (() => void) | undefined;
    try {
        controller.signal.throwIfAborted();
        const result = await Promise.race([
            new Promise<never>((_resolve, reject) => {
                rejectAbort = () => reject(controller.signal.reason);
                controller.signal.addEventListener("abort", rejectAbort, { once: true });
            }),
            read(controller.signal),
        ]);
        controller.signal.throwIfAborted();
        return result;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (rejectAbort !== undefined) controller.signal.removeEventListener("abort", rejectAbort);
    }
}
