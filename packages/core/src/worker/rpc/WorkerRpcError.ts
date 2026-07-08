import { ControlError, type ControlErrorInit, type JsonValue } from "@portable-devshell/shared";

import type { WorkerRpcErrorBody } from "./WorkerRpcEnvelope.js";

export const workerRpcDisconnectedErrorCode = "core.workerRpcDisconnected";

export class WorkerRpcError extends ControlError {
    constructor(body: ControlErrorInit | WorkerRpcErrorBody) {
        super(body);
        this.name = "WorkerRpcError";
    }

    static disconnected(details?: JsonValue, cause?: unknown): WorkerRpcError {
        return new WorkerRpcError({
            code: workerRpcDisconnectedErrorCode,
            cause,
            message: "Worker RPC bridge disconnected.",
            retryable: false,
            details
        });
    }
}
