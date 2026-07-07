import type { JsonValue } from "../type/TypeJsonValue.js";
import type { ErrorCode } from "./ErrorCodeCatalog.js";

export interface ControlErrorBody {
    code: ErrorCode;
    details?: JsonValue;
    message: string;
    retryable: boolean;
}

export class ControlError extends Error implements ControlErrorBody {
    readonly code: ErrorCode;
    readonly details?: JsonValue;
    readonly retryable: boolean;

    constructor(body: ControlErrorBody) {
        super(body.message);
        this.name = "ControlError";
        this.code = body.code;
        this.details = body.details;
        this.retryable = body.retryable;
    }
}
