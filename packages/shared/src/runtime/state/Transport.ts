// Thin typed runtime transport over the generic endpoint/RPC/stream transport.
// Lifecycle calls open one RPC per operation; start and subscribe own their
// message streams for the lifetime of the operation.

import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../transport/packet/Rpc.js";
import { Stream, type MessageStream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import { InstanceEventStream } from "../activity/EventStream.js";
import type {
    InstanceEventStreamPort,
    InstanceStreamEnvelope,
} from "../activity/Contract.js";
import type {
    InstanceLogEntry,
    InstanceLogQuery,
} from "../activity/Model.js";
import { asInstanceName } from "../identity/Model.js";
import {
    readInstanceSnapshot,
    runtimeOperations,
    type RuntimeOperation,
    type RuntimeRequest,
    type RuntimeResponse,
} from "./Contract.js";
import type { InstanceSnapshot } from "./Model.js";

export const RUNTIME_PORT = "runtime";

export interface RuntimeStartOptions {
    onOutput?(chunk: string): void;
    onRequestId?(requestId: string): void;
    signal?: AbortSignal;
}

export interface RuntimeStartHandle {
    cancel(): void;
    requestId: string;
    snapshot: Promise<InstanceSnapshot>;
}

export interface RuntimeTransport {
    readLogs(instance: string, query?: InstanceLogQuery): Promise<InstanceLogEntry[]>;
    refresh(instance: string): Promise<RuntimeResponse<"refresh">>;
    snapshot(instance: string): Promise<RuntimeResponse<"snapshot">>;
    start(
        instance: string,
        options?: RuntimeStartOptions,
    ): Promise<RuntimeStartHandle>;
    stop(instance: string): Promise<InstanceSnapshot>;
    subscribe(instance: string, fromSeq: number): Promise<InstanceEventStreamPort>;
}

export function createRuntimeTransport(endpoint: Endpoint): RuntimeTransport {
    const request = async <Operation extends RuntimeOperation>(
        instance: string,
        operation: Operation,
        payload: RuntimeRequest<Operation>,
    ): Promise<RuntimeResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(instance, RUNTIME_PORT));
        try {
            return await rpc.request<RuntimeResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    const open = async (
        instance: string,
        operation: string,
        payload?: JsonValue,
    ): Promise<MessageStream> => {
        const protocol = new Stream(await endpoint.connect(instance, RUNTIME_PORT));
        const stream = await protocol.open(operation, payload);
        const close = () => protocol.close();
        stream.onClose(close);
        stream.onCancel(close);
        return stream;
    };
    return {
        readLogs: (instance, query) =>
            request(instance, runtimeOperations.readLogs, query),
        refresh: (instance) =>
            request(instance, runtimeOperations.refresh, undefined),
        snapshot: (instance) =>
            request(instance, runtimeOperations.snapshot, undefined),
        start: (instance, options = {}) =>
            startRuntime(
                () => open(instance, runtimeOperations.start),
                options,
            ),
        stop: (instance) => request(instance, runtimeOperations.stop, undefined),
        subscribe: async (instance, fromSeq) =>
            new InstanceEventStream(
                asInstanceName(instance),
                await open(instance, runtimeOperations.subscribe, { fromSeq }),
            ),
    };
}

async function startRuntime(
    openStart: () => Promise<MessageStream>,
    options: RuntimeStartOptions,
): Promise<RuntimeStartHandle> {
    const stream = await openStart();
    options.onRequestId?.(stream.id);
    const offData = stream.onData((message) => {
        const envelope = message as InstanceStreamEnvelope;
        if (envelope.name !== "output") return;
        const payload = record(envelope.payload);
        if (typeof payload?.chunk === "string") options.onOutput?.(payload.chunk);
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
                    ? new Error("Runtime start was cancelled.")
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
                    : "Runtime start was cancelled.",
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
