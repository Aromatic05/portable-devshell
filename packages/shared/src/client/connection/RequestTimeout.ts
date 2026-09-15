export class RequestTimeoutError extends Error {
    constructor(
        readonly label: string,
        readonly timeoutMs: number,
        readonly outcome: "read" | "uncertain",
    ) {
        super(
            outcome === "uncertain"
                ? `${label} timed out locally after ${timeoutMs}ms; the underlying request may still complete. Refresh state before retrying.`
                : `${label} timed out after ${timeoutMs}ms.`,
        );
        this.name = "RequestTimeoutError";
    }
}

type RequestCanceller = (reason: Error) => void;
const requestCancellers = new WeakMap<Promise<unknown>, RequestCanceller>();

export function attachRequestCanceller<T>(request: Promise<T>, cancel: RequestCanceller): Promise<T> {
    requestCancellers.set(request, cancel);
    return request;
}

export function getRequestCanceller(request: Promise<unknown>): RequestCanceller | undefined {
    return requestCancellers.get(request);
}

export async function withRequestTimeout<T>(
    request: Promise<T>,
    timeoutMs: number,
    label: string,
    outcome: "read" | "uncertain" = "read",
): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await request;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            request,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    const error = new RequestTimeoutError(label, timeoutMs, outcome);
                    getRequestCanceller(request)?.(error);
                    reject(error);
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
