// Reverse enrollment belongs to the Control connection domain; observed
// connection state belongs to the instance process snapshot.

import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { ReverseDeviceCodeResult } from "./Model.js";

export interface ConnectionTransport {
    createCode(instance: string): Promise<ReverseDeviceCodeResult>;
    revokeToken(instance: string): Promise<{ instance: string; revoked: true }>;
    rotateToken(
        instance: string,
    ): Promise<{ deviceToken: string; instance: string }>;
}

export function createConnectionTransport(
    endpoint: Endpoint,
): ConnectionTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "connection");
    return {
        createCode: (instance) =>
            port.request<ReverseDeviceCodeResult>("createCode", { instance }),
        revokeToken: (instance) =>
            port.request<{ instance: string; revoked: true }>("revokeToken", {
                instance,
            }),
        rotateToken: (instance) =>
            port.request<{ deviceToken: string; instance: string }>(
                "rotateToken",
                { instance },
            ),
    };
}
