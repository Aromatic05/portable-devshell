import { randomUUID } from "node:crypto";

import type { JsonValue } from "@portable-devshell/shared";

import { WorkerRpcError } from "./WorkerRpcError.js";
import type { WorkerRpcRequestContext, WorkerRpcRequestEnvelope } from "./WorkerRpcEnvelope.js";
import { WorkerRpcBridge } from "./WorkerRpcBridge.js";

export class WorkerRpcClient {
    readonly #bridge: WorkerRpcBridge;
    readonly #ctxId = `ctx-rpc-${randomUUID()}`;
    #nextRequestId = 1;

    constructor(bridge: WorkerRpcBridge) {
        this.#bridge = bridge;
    }

    async request(
        method: string,
        params: JsonValue = {},
        context?: WorkerRpcRequestContext,
        signal?: AbortSignal,
        onProgress?: (progress: JsonValue) => void
    ): Promise<JsonValue> {
        const operationId = context?.operationId ?? randomUUID();
        const request: WorkerRpcRequestEnvelope = {
            type: "request",
            id: String(this.#nextRequestId++),
            method,
            params,
            context: {
                ...context,
                ctxId: context?.ctxId ?? this.#ctxId,
                operationId
            }
        };
        let lastSequence = 0;
        const unsubscribe = onProgress === undefined
            ? undefined
            : this.#bridge.onNotification((notification) => {
                const progress = readToolProgress(notification, operationId);
                if (progress === undefined || progress.sequence <= lastSequence) return;
                lastSequence = progress.sequence;
                try {
                    onProgress(progress.value);
                } catch (error) {
                    console.warn(error instanceof Error ? error : new Error(String(error)));
                }
            });
        let response;
        try {
            response = await this.#bridge.request(request, signal);
        } finally {
            unsubscribe?.();
        }

        if (response.ok) {
            return response.result;
        }

        throw new WorkerRpcError(response.error);
    }
}

function readToolProgress(
    notification: { method: string; params: JsonValue },
    operationId: string
): { sequence: number; value: JsonValue } | undefined {
    if (notification.method !== "tool.progress") return undefined;
    if (typeof notification.params !== "object" || notification.params === null || Array.isArray(notification.params)) {
        return undefined;
    }
    const params = notification.params as Record<string, JsonValue>;
    if (params.operationId !== operationId || typeof params.sequence !== "number" || !Number.isSafeInteger(params.sequence)) {
        return undefined;
    }
    return { sequence: params.sequence, value: params.value ?? null };
}
