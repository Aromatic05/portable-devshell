// Thin typed Context transport. Every operation is an RPC on the control
// `context` port.

import { CONTROL_HOST } from "../../control/connection/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import {
    contextOperations,
    type ContextOperation,
    type ContextRequestPayload,
    type ContextResponse,
} from "./Contract.js";
import type { McpContextRecord } from "./Model.js";

export const CONTEXT_PORT = "context";

export interface ContextTransport {
    disable(ctxId: string, signal?: AbortSignal): Promise<McpContextRecord>;
    list(signal?: AbortSignal): Promise<McpContextRecord[]>;
    renew(ctxId: string, signal?: AbortSignal): Promise<McpContextRecord>;
}

export function createContextTransport(endpoint: Endpoint): ContextTransport {
    return contextTransport(
        createPortClient(endpoint, CONTROL_HOST, CONTEXT_PORT),
    );
}

export function contextTransport(port: PortClient): ContextTransport {
    const request = <Operation extends ContextOperation>(
        operation: Operation,
        payload: ContextRequestPayload<Operation>,
        signal?: AbortSignal,
    ): Promise<ContextResponse<Operation>> =>
        port.request<ContextResponse<Operation>>(operation, payload, signal);
    return {
        disable: (ctxId, signal) =>
            request(contextOperations.disable, { ctxId }, signal),
        list: (signal) =>
            request(contextOperations.list, undefined, signal),
        renew: (ctxId, signal) =>
            request(contextOperations.renew, { ctxId }, signal),
    };
}