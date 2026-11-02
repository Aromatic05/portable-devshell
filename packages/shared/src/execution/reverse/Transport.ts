// Reverse enrollment belongs to the Control connection domain; observed
// connection state belongs to the instance process snapshot.

import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { ReverseDeviceCodeResult } from "./Model.js";

export interface ConnectionTransport {
    createCode(instance: string, signal?: AbortSignal): Promise<ReverseDeviceCodeResult>;
    revokeToken(instance: string, signal?: AbortSignal): Promise<{ instance: string; revoked: true }>;
    rotateToken(
        instance: string,
        signal?: AbortSignal,
    ): Promise<{ deviceToken: string; instance: string }>;
}

export function createConnectionTransport(
    endpoint: Endpoint,
): ConnectionTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "connection");
    return {
        createCode: (instance, signal) =>
            port.request<ReverseDeviceCodeResult>("createCode", { instance }, signal),
        revokeToken: (instance, signal) =>
            port.request<{ instance: string; revoked: true }>("revokeToken", {
                instance,
            }, signal),
        rotateToken: (instance, signal) =>
            port.request<{ deviceToken: string; instance: string }>(
                "rotateToken",
                { instance },
                signal,
            ),
    };
}
