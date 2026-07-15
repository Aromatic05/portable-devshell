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
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const request: WorkerRpcRequestEnvelope = {
            type: "request",
            id: String(this.#nextRequestId++),
            method,
            params,
            context: {
                ...context,
                ctxId: context?.ctxId ?? this.#ctxId,
                operationId: randomUUID()
            }
        };
        const response = await this.#bridge.request(request, signal);

        if (response.ok) {
            return response.result;
        }

        throw new WorkerRpcError(response.error);
    }
}
