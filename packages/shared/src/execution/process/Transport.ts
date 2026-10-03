// Thin typed process transport over the generic endpoint port client.

import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import type { MessageStream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../types/Json.js";
import {
    type EventStreamEnvelope,
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../client/Stream.js";
import type {
    ProcessEvent,
    InstanceLogEntry,
    InstanceLogQuery,
} from "./Event.js";
import { asInstanceName } from "../../types/Instance.js";
import { readInstanceSnapshot } from "./Snapshot.js";
import type { InstanceProcessEnvelope, InstanceSnapshot } from "./Model.js";

export const PROCESS_PORT = "process";

export interface ProcessStartOptions {
    onOutput?(chunk: string): void;
    onRequestId?(requestId: string): void;
    signal?: AbortSignal;
}

export interface ProcessStartHandle {
    cancel(): void;
    requestId: string;
    snapshot: Promise<InstanceSnapshot>;
}

export interface ProcessTransport {
    readLogs(
        instance: string,
        query?: InstanceLogQuery,
    ): Promise<InstanceLogEntry[]>;
    refresh(instance: string): Promise<InstanceProcessEnvelope>;
    snapshot(instance: string): Promise<InstanceProcessEnvelope>;
    start(
        instance: string,
        options?: ProcessStartOptions,
    ): Promise<ProcessStartHandle>;
    stop(instance: string): Promise<InstanceSnapshot>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort<ProcessEvent>>;
}

export function createProcessTransport(endpoint: Endpoint): ProcessTransport {
    const port = (instance: string): PortClient =>
        createPortClient(endpoint, instance, PROCESS_PORT);
    const open = (
        instance: string,
        operation: string,
        payload?: JsonValue,
    ): Promise<MessageStream> => port(instance).open(operation, payload);
    return {
        readLogs: (instance, query) =>
            port(instance).request<InstanceLogEntry[]>("readLogs", query),
        refresh: (instance) =>
            port(instance).request<InstanceProcessEnvelope>("refresh"),
        snapshot: (instance) =>
            port(instance).request<InstanceProcessEnvelope>("snapshot"),
        start: (instance, options = {}) =>
            startProcess(() => open(instance, "start"), options),
        stop: (instance) => port(instance).request<InstanceSnapshot>("stop"),
        subscribe: async (instance, fromSeq) =>
            new InstanceEventStream<ProcessEvent>(
                asInstanceName(instance),
                await open(instance, "subscribe", { fromSeq }),
            ),
    };
}

async function startProcess(
    openStart: () => Promise<MessageStream>,
    options: ProcessStartOptions,
): Promise<ProcessStartHandle> {
    const stream = await openStart();
    options.onRequestId?.(stream.id);
    const offData = stream.onData((message) => {
        const envelope = message as EventStreamEnvelope;
        if (envelope.name !== "output") return;
        const payload = record(envelope.payload);
        if (typeof payload?.chunk === "string")
            options.onOutput?.(payload.chunk);
    });
    const start = new Promise<InstanceSnapshot>((resolve, reject) => {
        stream.onClose((message) => {
            try {
                resolve(readInstanceSnapshot(message as JsonValue | undefined));
            } catch (error) {
                reject(error);
            }
        });
        stream.onCancel((error) => {
            reject(
                error === undefined
                    ? new Error("Process start was cancelled.")
                    : objectError(error),
            );
        });
    });
    const cancel = () => {
        options.signal?.removeEventListener("abort", cancel);
        void stream.cancel({
            message:
                options.signal?.reason instanceof Error
                    ? options.signal.reason.message
                    : "Process start was cancelled.",
        });
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted === true) cancel();
    const snapshot = start.finally(() => {
        offData();
        options.signal?.removeEventListener("abort", cancel);
    });
    return { cancel, requestId: stream.id, snapshot };
}

function record(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function objectError(error: {
    code?: string;
    details?: unknown;
    message: string;
    retryable?: boolean;
}): Error {
    return Object.assign(new Error(error.message), {
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.retryable === undefined
            ? {}
            : { retryable: error.retryable }),
    });
}
