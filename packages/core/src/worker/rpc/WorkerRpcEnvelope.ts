import { createError, type ControlErrorBody, type ErrorCode, type JsonValue } from "@portable-devshell/shared";

export interface WorkerRpcRequestContext {
    requestId?: string;
    operationId?: string;
    ctxId?: string;
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

export interface WorkerRpcNotificationEnvelope extends Record<string, JsonValue> {
    type: "notification";
    method: string;
    params: JsonValue;
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

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function encodeWorkerRpcMessage(value: JsonValue): Uint8Array {
    return encoder.encode(JSON.stringify(value));
}

export function decodeWorkerRpcMessage(frame: Uint8Array): JsonValue {
    if (frame.byteLength === 0) {
        throw invalidJson("Worker RPC frame payload must not be empty.");
    }
    try {
        return JSON.parse(decoder.decode(frame)) as JsonValue;
    } catch (error) {
        throw invalidJson(`Worker RPC frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function invalidJson(message: string): Error {
    return createError({ code: "protocol.invalidJson" as ErrorCode, message, retryable: false });
}
