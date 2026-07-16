import type { JsonValue } from "../type/TypeJsonValue.js";

export interface ControlErrorBody {
    code: string;
    cause?: ControlErrorBody;
    details?: JsonValue;
    message: string;
    retryable: boolean;
}

export interface ControlErrorInit {
    code: string;
    cause?: unknown;
    details?: JsonValue;
    message: string;
    retryable: boolean;
}

export class ControlError extends Error {
    readonly code: string;
    readonly details?: JsonValue;
    readonly retryable: boolean;
    readonly causeBody?: ControlErrorBody;

    constructor(body: ControlErrorInit) {
        super(body.message, body.cause instanceof Error ? { cause: body.cause } : undefined);
        this.name = "ControlError";
        this.code = body.code;
        this.details = body.details;
        this.retryable = body.retryable;
        this.causeBody = toControlErrorBody(body.cause);
    }

    toBody(): ControlErrorBody {
        return {
            code: this.code,
            ...(this.causeBody === undefined ? {} : { cause: this.causeBody }),
            ...(this.details === undefined ? {} : { details: this.details }),
            message: this.message,
            retryable: this.retryable
        };
    }
}

export function isControlErrorBody(value: unknown): value is ControlErrorBody {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.code === "string" &&
        typeof candidate.message === "string" &&
        typeof candidate.retryable === "boolean" &&
        (candidate.cause === undefined || isControlErrorBody(candidate.cause))
    );
}

export function toControlErrorBody(error: unknown): ControlErrorBody | undefined {
    if (error instanceof ControlError) {
        return error.toBody();
    }

    if (!(error instanceof Error) && isControlErrorBody(error)) {
        return error;
    }

    if (typeof error !== "object" || error === null || Array.isArray(error)) {
        return undefined;
    }

    const candidate = error as {
        cause?: unknown;
        code?: unknown;
        details?: JsonValue;
        message?: unknown;
        retryable?: unknown;
    };

    if (typeof candidate.message !== "string") {
        return undefined;
    }

    const cause = toControlErrorBody(candidate.cause);
    return {
        code: typeof candidate.code === "string" ? candidate.code : "error.unknown",
        ...(cause === undefined ? {} : { cause }),
        ...(candidate.details === undefined ? {} : { details: candidate.details }),
        message: candidate.message,
        retryable: typeof candidate.retryable === "boolean" ? candidate.retryable : false
    };
}
