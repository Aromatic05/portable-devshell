import {
    ClientConnection,
    createControlClients,
    createError,
    type Channel,
    type ControlClients,
    type ControlErrorBody,
    type InstanceEventStream,
    type McpRuntimeStatus,
} from "@portable-devshell/shared/browser";

import { connectBrowserWebSocketChannel } from "../rpc/WebSocketConnector.js";

export interface WebClients extends ControlClients {
    close(): void;
    onTransportClose(listener: (error: Error) => void): () => void;
    reconnect(): Promise<void>;
}

export type WebRuntimeStream = InstanceEventStream;
export type McpStatus = McpRuntimeStatus;
export type WebChannelConnector = (
    signal?: AbortSignal,
) => Promise<Channel>;

export function createWebClients(
    connectChannel: WebChannelConnector = connectBrowserWebSocketChannel,
): WebClients {
    const transportCloseListeners = new Set<(error: Error) => void>();
    let connectionGeneration = 0;
    const connection = new ClientConnection({
        connectChannel: async (signal) => {
            const generation = ++connectionGeneration;
            const channel = await connectChannel(signal);
            channel.onClose((error) => {
                if (generation !== connectionGeneration) return;
                const reason = error ?? new Error("WebSocket connection closed.");
                for (const listener of [...transportCloseListeners]) {
                    listener(reason);
                }
            });
            return channel;
        },
        mapError,
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "web",
    });
    const clients = createControlClients(connection, { clientKind: "web" });
    return {
        ...clients,
        close: () => connection.close(),
        onTransportClose: (listener) => {
            transportCloseListeners.add(listener);
            return () => transportCloseListeners.delete(listener);
        },
        reconnect: async () => await connection.reconnect(),
    };
}

function mapError(error: unknown): Error {
    if (isControlErrorBody(error)) return createError(error);
    return error instanceof Error ? error : new Error(String(error));
}

function isControlErrorBody(value: unknown): value is ControlErrorBody {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const body = value as Partial<ControlErrorBody>;
    return typeof body.code === "string" &&
        typeof body.message === "string" &&
        typeof body.retryable === "boolean";
}
