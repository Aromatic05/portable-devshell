export class TuiRequestTimeoutError extends Error {
    constructor(readonly label: string, readonly timeoutMs: number) {
        super(`${label} timed out locally after ${timeoutMs}ms; the underlying request may still complete. Refresh state before retrying a mutating action.`);
        this.name = "TuiRequestTimeoutError";
    }
}

export async function withTuiRequestTimeout<T>(
    request: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await request;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
            () => reject(new TuiRequestTimeoutError(label, timeoutMs)),
            timeoutMs,
        );
    });
    try {
        return await Promise.race([request, expired]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}
