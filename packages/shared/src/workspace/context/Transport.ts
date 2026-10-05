import {
    EventStreamReader,
    readStreamGapPayload,
    type EventStreamPort,
} from "../../client/Stream.js";
import {
    readContextSnapshot,
    readContextChangeEvent,
    type ContextSnapshot,
    type ContextChangeEvent,
} from "./Revision.js";
export type { ContextSnapshot, ContextChangeEvent } from "./Revision.js";
import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type {
    ContextExternalBinding,
    ContextInstanceReference,
    ContextQuery,
    ContextRecord,
} from "./Model.js";

export interface ContextResolveInput {
    acceptExpired?: boolean;
    externalBindings?: readonly ContextExternalBinding[];
    ctxId?: string;
    instance?: string;
    principal: string;
    renewExpired?: boolean;
    touch?: boolean;
}

export interface ContextTransport {
    snapshot(signal?: AbortSignal): Promise<ContextSnapshot>;
    subscribe(
        fromRevision: number,
    ): Promise<EventStreamPort<ContextChangeEvent>>;
    disable(ctxId: string, signal?: AbortSignal): Promise<ContextRecord>;
    list(query?: ContextQuery, signal?: AbortSignal): Promise<ContextRecord[]>;
    renew(ctxId: string, signal?: AbortSignal): Promise<ContextRecord>;
    resolve(
        input: ContextResolveInput,
        signal?: AbortSignal,
    ): Promise<ContextRecord>;
    referenceInstance(
        ctxId: string,
        instance: string,
        signal?: AbortSignal,
    ): Promise<ContextInstanceReference | undefined>;
    validateForInstance(
        ctxId: string,
        instance: string,
        signal?: AbortSignal,
    ): Promise<ContextRecord>;
    detachInstance(
        instance: string,
        signal?: AbortSignal,
    ): Promise<ContextRecord[]>;
    reconcileInstance(instance: string, signal?: AbortSignal): Promise<void>;
}

export function createContextTransport(endpoint: Endpoint): ContextTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "context");
    return {
        snapshot: async (signal) =>
            readContextSnapshot(
                await port.request("snapshot", undefined, signal),
            ),
        subscribe: async (fromRevision) =>
            new EventStreamReader(
                await port.open("subscribe", { fromRevision }),
                {
                    decodeEvent: readContextChangeEvent,
                    readGap: readStreamGapPayload,
                },
            ),
        disable: (ctxId, signal) =>
            port.request<ContextRecord>("disable", { ctxId }, signal),
        list: (query, signal) =>
            port.request<ContextRecord[]>("list", query, signal),
        renew: (ctxId, signal) =>
            port.request<ContextRecord>("renew", { ctxId }, signal),
        resolve: (input, signal) =>
            port.request<ContextRecord>("resolve", input, signal),
        referenceInstance: (ctxId, instance, signal) =>
            port.request<ContextInstanceReference | undefined>(
                "referenceInstance",
                { ctxId, instance },
                signal,
            ),
        validateForInstance: (ctxId, instance, signal) =>
            port.request<ContextRecord>(
                "validateForInstance",
                { ctxId, instance },
                signal,
            ),
        detachInstance: (instance, signal) =>
            port.request<ContextRecord[]>(
                "detachInstance",
                { instance },
                signal,
            ),
        reconcileInstance: async (instance, signal) => {
            await port.request("reconcileInstance", { instance }, signal);
        },
    };
}
