import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import { CONTROL_HOST } from "../connection/Control.js";
import {
    serviceOperations,
    type ServiceOperation,
    type ServiceRequest,
    type ServiceResponse,
} from "./Contract.js";
import {
    CONTROL_PROTOCOL_RANGE,
    type ControlClientKind,
    type ControlProtocolHelloResponse,
} from "./Model.js";
import type { ControlServiceStatus } from "./Model.js";

export interface ServiceTransport {
    hello(): Promise<ControlProtocolHelloResponse>;
    ping(): Promise<{ pong: boolean }>;
    restart(): Promise<Record<string, JsonValue>>;
    status(): Promise<ControlServiceStatus>;
}

export function createServiceTransport(
    endpoint: Endpoint,
    options: { clientKind: ControlClientKind },
): ServiceTransport {
    return serviceTransport(
        createPortClient(endpoint, CONTROL_HOST, "service"),
        options,
    );
}

export function serviceTransport(
    port: PortClient,
    options: { clientKind: ControlClientKind },
): ServiceTransport {
    const request = <Operation extends ServiceOperation>(
        operation: Operation,
        payload: ServiceRequest<Operation>,
    ): Promise<ServiceResponse<Operation>> =>
        port.request<ServiceResponse<Operation>>(operation, payload);
    return {
        hello: () =>
            request(serviceOperations.hello, {
                clientKind: options.clientKind,
                protocolRange: CONTROL_PROTOCOL_RANGE,
            }),
        ping: () => request(serviceOperations.ping, undefined),
        restart: () => request(serviceOperations.restart, undefined),
        status: () => request(serviceOperations.status, undefined),
    };
}