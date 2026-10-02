// Control service handshake wire contract for the Control service port. The
// transport in ./Transport.ts is typed against this map. This port carries no
// streams; negotiated stream capabilities are reported in the hello response.

import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import type {
    ControlProtocolHelloRequest,
    ControlProtocolHelloResponse,
    ControlServiceStatus,
} from "./Model.js";

export const serviceOperations = {
    hello: "hello",
    ping: "ping",
    restart: "restart",
    status: "status",
} as const;

export interface ServiceContract {
    hello: {
        request: ControlProtocolHelloRequest;
        response: ControlProtocolHelloResponse;
    };
    ping: {
        request: undefined;
        response: { pong: boolean };
    };
    restart: {
        request: undefined;
        response: Record<string, JsonValue>;
    };
    status: {
        request: undefined;
        response: ControlServiceStatus;
    };
}

export type ServiceOperation = keyof ServiceContract;

export type ServiceRequest<Operation extends ServiceOperation> =
    ServiceContract[Operation]["request"];

export type ServiceResponse<Operation extends ServiceOperation> =
    ServiceContract[Operation]["response"];