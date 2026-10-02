import type { Endpoint } from "./Endpoint.js";
import type { Host, PortName } from "./Address.js";
import { Rpc } from "../packet/Rpc.js";
import { Stream, type MessageStream } from "../packet/Stream.js";
import { attachRequestCanceller } from "../primitive/RequestTimeout.js";

/**
 * Domain-blind RPC and stream surface of one endpoint port. Callers bind the
 * host and port; no domain knowledge lives here.
 */
export interface PortClient {
    request<T>(
        operation: string,
        payload?: unknown,
        signal?: AbortSignal,
    ): Promise<T>;
    open(operation: string, payload?: unknown): Promise<MessageStream>;
}

export function createPortClient(
    endpoint: Endpoint,
    host: Host,
    port: PortName,
): PortClient {
    return {
        request: (operation, payload, signal) =>
            request(endpoint, host, port, operation, payload, signal),
        open: (operation, payload) =>
            open(endpoint, host, port, operation, payload),
    };
}

function request<T>(
    endpoint: Endpoint,
    host: Host,
    port: PortName,
    operation: string,
    payload?: unknown,
    signal?: AbortSignal,
): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const result = (async () => {
        try {
            const rpc = new Rpc(
                await endpoint.connect(host, port, controller.signal),
            );
            try {
                return await rpc.request<T>(
                    operation,
                    payload,
                    controller.signal,
                );
            } finally {
                rpc.close();
            }
        } finally {
            signal?.removeEventListener("abort", abort);
        }
    })();
    return attachRequestCanceller(result, (reason) =>
        controller.abort(reason),
    );
}

async function open(
    endpoint: Endpoint,
    host: Host,
    port: PortName,
    operation: string,
    payload?: unknown,
): Promise<MessageStream> {
    const protocol = new Stream(await endpoint.connect(host, port));
    const stream = await protocol.open(operation, payload);
    const close = () => protocol.close();
    stream.onClose(close);
    stream.onCancel(close);
    return stream;
}
