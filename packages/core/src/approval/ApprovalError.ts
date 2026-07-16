import type { JsonValue } from "@portable-devshell/shared";

export class ApprovalError extends Error {
    readonly code: string;
    readonly details?: JsonValue;
    readonly retryable = false;

    constructor(code: string, message: string, details?: JsonValue) {
        super(message);
        this.name = "ApprovalError";
        this.code = code;
        this.details = details;
    }
}
