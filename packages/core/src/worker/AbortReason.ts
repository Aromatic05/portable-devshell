export function readWorkerAbortReason(reason: unknown): string {
    if (typeof reason === "string" && reason.length > 0) {
        return reason;
    }
    if (reason instanceof Error && reason.message.length > 0) {
        return reason.message;
    }
    return "client cancelled";
}
