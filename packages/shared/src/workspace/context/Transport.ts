import { EventStreamReader, readStreamGapPayload, type EventStreamPort } from "../../client/Stream.js";
import { readContextSnapshot, readContextChangeEvent, type ContextSnapshot, type ContextChangeEvent } from "./Revision.js";
export type { ContextSnapshot, ContextChangeEvent } from "./Revision.js";
import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { McpContextRecord } from "./Model.js";

export interface ContextTransport {
    snapshot(signal?: AbortSignal): Promise<ContextSnapshot>;
    subscribe(fromRevision: number): Promise<EventStreamPort<ContextChangeEvent>>;
    disable(ctxId: string, signal?: AbortSignal): Promise<McpContextRecord>;
    list(signal?: AbortSignal): Promise<McpContextRecord[]>;
    renew(ctxId: string, signal?: AbortSignal): Promise<McpContextRecord>;
}

export function createContextTransport(endpoint: Endpoint): ContextTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "context");
    return {
        snapshot: async (signal) => readContextSnapshot(await port.request("snapshot", undefined, signal)),
        subscribe: async (fromRevision) => new EventStreamReader(await port.open("subscribe", { fromRevision }), {
            decodeEvent: readContextChangeEvent,
            readGap: readStreamGapPayload,
        }),
        disable: (ctxId, signal) =>
            port.request<McpContextRecord>("disable", { ctxId }, signal),
        list: (signal) =>
            port.request<McpContextRecord[]>("list", undefined, signal),
        renew: (ctxId, signal) =>
            port.request<McpContextRecord>("renew", { ctxId }, signal),
    };
}
