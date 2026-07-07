import type { JsonValue } from "../../../shared/dist/types/JsonValue.js";

import { WorkerRpcError } from "../protocol/WorkerRpcError.js";
import type { WorkerRpcRequestEnvelope } from "../protocol/WorkerRpcEnvelope.js";
import { WorkerRpcBridge } from "./WorkerRpcBridge.js";

export class WorkerRpcClient {
    readonly #bridge: WorkerRpcBridge;
    #nextRequestId = 1;

    constructor(bridge: WorkerRpcBridge) {
        this.#bridge = bridge;
    }

    async request(method: string, params: JsonValue = {}): Promise<JsonValue> {
        const request: WorkerRpcRequestEnvelope = {
            type: "request",
            id: String(this.#nextRequestId++),
            method,
            params
        };
        const response = await this.#bridge.request(request);

        if (response.ok) {
            return response.result;
        }

        throw new WorkerRpcError(response.error);
    }
}
