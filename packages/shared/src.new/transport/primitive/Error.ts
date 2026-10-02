import type { JsonValue } from "./JsonValue.js";

// Generic transport/protocol error codes. These are named constants rather than
// a domain catalog: they describe transport mechanics, not a bounded context's
// failure vocabulary.
export const TRANSPORT_METHOD_NOT_FOUND_CODE = "method_not_found";
export const TRANSPORT_PROTOCOL_INVALID_FRAME_CODE = "protocol.invalidFrame";
export const TRANSPORT_PROTOCOL_FRAME_TOO_LARGE_CODE = "protocol.frameTooLarge";
export const TRANSPORT_PROTOCOL_VERSION_UNSUPPORTED_CODE =
    "protocol.versionUnsupported";

const unknownErrorCode = "error.unknown";

export interface RemoteErrorBody {
    code: string;
    cause?: RemoteErrorBody;
    details?: JsonValue;
    message: string;
    retryable: boolean;
}

export interface RemoteErrorInit {
    code: string;
    cause?: unknown;
    details?: JsonValue;
    message: string;
    retryable: boolean;
}

export class RemoteError extends Error {
    readonly code: string;
    readonly details?: JsonValue;
    readonly retryable: boolean;
    readonly causeBody?: RemoteErrorBody;

    constructor(body: RemoteErrorInit) {
        super(
            body.message,
            body.cause instanceof Error ? { cause: body.cause } : undefined,
        );
        this.name = "RemoteError";
        this.code = body.code;
        this.details = body.details;
        this.retryable = body.retryable;
        this.causeBody = toRemoteErrorBody(body.cause);
    }

    toBody(): RemoteErrorBody {
        return {
            code: this.code,
            ...(this.causeBody === undefined ? {} : { cause: this.causeBody }),
            ...(this.details === undefined ? {} : { details: this.details }),
            message: this.message,
            retryable: this.retryable,
        };
    }
}

export function isRemoteErrorBody(value: unknown): value is RemoteErrorBody {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.code === "string" &&
        typeof candidate.message === "string" &&
        typeof candidate.retryable === "boolean" &&
        (candidate.cause === undefined || isRemoteErrorBody(candidate.cause))
    );
}

export function toRemoteErrorBody(error: unknown): RemoteErrorBody | undefined {
    if (error instanceof RemoteError) return error.toBody();
    if (!(error instanceof Error) && isRemoteErrorBody(error)) return error;
    if (typeof error !== "object" || error === null || Array.isArray(error))
        return undefined;

    const candidate = error as {
        cause?: unknown;
        code?: unknown;
        details?: JsonValue;
        message?: unknown;
        retryable?: unknown;
    };
    if (typeof candidate.message !== "string") return undefined;

    const cause = toRemoteErrorBody(candidate.cause);
    return {
        code:
            typeof candidate.code === "string"
                ? candidate.code
                : unknownErrorCode,
        ...(cause === undefined ? {} : { cause }),
        ...(candidate.details === undefined
            ? {}
            : { details: candidate.details }),
        message: candidate.message,
        retryable:
            typeof candidate.retryable === "boolean"
                ? candidate.retryable
                : false,
    };
}

export function createRemoteError(body: RemoteErrorInit): RemoteError {
    return new RemoteError(body);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function toRemoteError(
    error: unknown,
    fallbackCode = unknownErrorCode,
): RemoteError {
    if (error instanceof RemoteError) return error;
    const body = toRemoteErrorBody(error);
    return createRemoteError({
        code:
            body?.code === undefined || body.code === unknownErrorCode
                ? fallbackCode
                : body.code,
        ...(body?.details === undefined ? {} : { details: body.details }),
        message: body?.message ?? errorMessage(error),
        retryable: body?.retryable === true,
    });
}
