import type { ControlErrorBody, JsonValue } from "@portable-devshell/shared";

export interface WorkerRpcRequestContext {
    requestId?: string;
    sessionId?: string;
    source?: string;
}

export interface WorkerRpcRequestEnvelope {
    type: "request";
    id: string;
    method: string;
    params: JsonValue;
    context?: WorkerRpcRequestContext;
}

export type WorkerRpcErrorBody = ControlErrorBody;

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
