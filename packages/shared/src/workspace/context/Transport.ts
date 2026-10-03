import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { McpContextRecord } from "./Model.js";

export interface ContextTransport {
    disable(ctxId: string, signal?: AbortSignal): Promise<McpContextRecord>;
    list(signal?: AbortSignal): Promise<McpContextRecord[]>;
    renew(ctxId: string, signal?: AbortSignal): Promise<McpContextRecord>;
}

export function createContextTransport(endpoint: Endpoint): ContextTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "context");
    return {
        disable: (ctxId, signal) =>
            port.request<McpContextRecord>("disable", { ctxId }, signal),
        list: (signal) =>
            port.request<McpContextRecord[]>("list", undefined, signal),
        renew: (ctxId, signal) =>
            port.request<McpContextRecord>("renew", { ctxId }, signal),
    };
}
