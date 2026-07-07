import type { JsonValue } from "../../../../shared/dist/types/JsonValue.js";

export interface WorkerRpcRequestEnvelope {
    type: "request";
    id: string;
    method: string;
    params: JsonValue;
}

export interface WorkerRpcErrorBody {
    code: string;
    message: string;
    retryable: boolean;
    details?: JsonValue;
}

export interface WorkerRpcSuccessEnvelope {
    type: "response";
    id: string;
    ok: true;
    result: JsonValue;
}

export interface WorkerRpcFailureEnvelope {
    type: "response";
    id: string;
    ok: false;
    error: WorkerRpcErrorBody;
}

export type WorkerRpcResponseEnvelope = WorkerRpcSuccessEnvelope | WorkerRpcFailureEnvelope;
export type WorkerRpcEnvelope = WorkerRpcRequestEnvelope | WorkerRpcResponseEnvelope;
