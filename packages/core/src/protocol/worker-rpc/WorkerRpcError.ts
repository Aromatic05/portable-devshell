import type { JsonValue } from "../../../../shared/dist/types/JsonValue.js";

import type { WorkerRpcErrorBody } from "./WorkerRpcEnvelope.js";

export const workerRpcDisconnectedErrorCode = "core.workerRpcDisconnected";

export class WorkerRpcError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly details?: JsonValue;

    constructor(body: WorkerRpcErrorBody) {
        super(body.message);
        this.name = "WorkerRpcError";
        this.code = body.code;
        this.retryable = body.retryable;
        this.details = body.details;
    }

    static disconnected(details?: JsonValue): WorkerRpcError {
        return new WorkerRpcError({
            code: workerRpcDisconnectedErrorCode,
            message: "Worker RPC bridge disconnected.",
            retryable: false,
            details
        });
    }
}
