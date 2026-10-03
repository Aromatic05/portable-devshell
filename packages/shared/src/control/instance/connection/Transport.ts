// Thin typed reverse-connection transport. Enrollment operations run on the
// Control reverse port; runtime reverse status is part of the instance
// snapshot, not this transport.

import type { Endpoint } from "../../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../../transport/packet/Rpc.js";
import {
    reverseOperations,
    type ReverseOperation,
    type ReverseRequest,
    type ReverseResponse,
} from "./Contract.js";
import type { ReverseDeviceCodeResult } from "./Model.js";

export const REVERSE_HOST = "@control";
export const REVERSE_PORT = "reverse";

export interface ReverseConnectionTransport {
    createCode(instance: string): Promise<ReverseDeviceCodeResult>;
    revokeToken(
        instance: string,
    ): Promise<ReverseResponse<"revokeToken">>;
    rotateToken(instance: string): Promise<ReverseResponse<"rotateToken">>;
}

export function createReverseConnectionTransport(
    endpoint: Endpoint,
): ReverseConnectionTransport {
    const request = async <Operation extends ReverseOperation>(
        operation: Operation,
        payload: ReverseRequest<Operation>,
    ): Promise<ReverseResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(REVERSE_HOST, REVERSE_PORT));
        try {
            return await rpc.request<ReverseResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        createCode: (instance) =>
            request(reverseOperations.createCode, { instance }),
        revokeToken: (instance) =>
            request(reverseOperations.revokeToken, { instance }),
        rotateToken: (instance) =>
            request(reverseOperations.rotateToken, { instance }),
    };
}
