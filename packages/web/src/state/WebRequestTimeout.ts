export class WebRequestTimeoutError extends Error {
    constructor(readonly label: string, readonly timeoutMs: number) {
        super(`${label} timed out after ${timeoutMs}ms.`);
        this.name = "WebRequestTimeoutError";
    }
}

export async function withWebRequestTimeout<T>(
    request: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await request;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new WebRequestTimeoutError(label, timeoutMs)), timeoutMs);
    });
    try {
        return await Promise.race([request, expired]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}
