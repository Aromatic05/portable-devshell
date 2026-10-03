export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class RequestTimeoutError extends Error {
    readonly outcome: "read" | "uncertain";

    constructor(label: string, outcome: "read" | "uncertain") {
        super(`${label} timed out.`);
        this.name = "RequestTimeoutError";
        this.outcome = outcome;
    }
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
                timer = setTimeout(
                    () => reject(new RequestTimeoutError(label, outcome)),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
