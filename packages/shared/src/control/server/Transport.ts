import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { JsonValue } from "../../types/Json.js";
import {
    CONTROL_PROTOCOL_RANGE,
    type ControlClientKind,
    type ControlProtocolHelloResponse,
    type ControlServerStatus,
} from "./Model.js";

export interface ServerTransport {
    hello(): Promise<ControlProtocolHelloResponse>;
    ping(): Promise<{ pong: boolean }>;
    restart(): Promise<Record<string, JsonValue>>;
    shutdown(): Promise<Record<string, JsonValue>>;
    status(): Promise<ControlServerStatus>;
}

export function createServerTransport(
    endpoint: Endpoint,
    options: { clientKind: ControlClientKind },
): ServerTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "server");
    return {
        hello: () =>
            port.request<ControlProtocolHelloResponse>("hello", {
                clientKind: options.clientKind,
                protocolRange: CONTROL_PROTOCOL_RANGE,
            }),
        ping: () => port.request<{ pong: boolean }>("ping"),
        restart: () => port.request<Record<string, JsonValue>>("restart"),
        shutdown: () => port.request<Record<string, JsonValue>>("shutdown"),
        status: () => port.request<ControlServerStatus>("status"),
    };
}
