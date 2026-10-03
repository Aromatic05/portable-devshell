import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { JsonValue } from "../../types/Json.js";
import {
    CONTROL_PROTOCOL_RANGE,
    type ControlClientKind,
    type ControlProtocolHelloResponse,
    type ControlServiceStatus,
} from "./Model.js";

export interface ServiceTransport {
    hello(): Promise<ControlProtocolHelloResponse>;
    ping(): Promise<{ pong: boolean }>;
    restart(): Promise<Record<string, JsonValue>>;
    shutdown(): Promise<Record<string, JsonValue>>;
    status(): Promise<ControlServiceStatus>;
}

export function createServiceTransport(
    endpoint: Endpoint,
    options: { clientKind: ControlClientKind },
): ServiceTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "service");
    return {
        hello: () =>
            port.request<ControlProtocolHelloResponse>("hello", {
                clientKind: options.clientKind,
                protocolRange: CONTROL_PROTOCOL_RANGE,
            }),
        ping: () => port.request<{ pong: boolean }>("ping"),
        restart: () => port.request<Record<string, JsonValue>>("restart"),
        shutdown: () => port.request<Record<string, JsonValue>>("shutdown"),
        status: () => port.request<ControlServiceStatus>("status"),
    };
}
