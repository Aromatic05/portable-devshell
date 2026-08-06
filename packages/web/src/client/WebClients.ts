import {
    createError,
    createPersistentControlClients,
    type Channel,
    type ControlErrorBody,
    type InstanceEventStream,
    type McpRuntimeStatus,
    type PersistentControlClients,
} from "@portable-devshell/shared/browser";

import { connectBrowserWebSocketChannel } from "../rpc/WebSocketConnector.js";

export type WebClients = PersistentControlClients;
export type WebRuntimeStream = InstanceEventStream;
export type McpStatus = McpRuntimeStatus;
export type WebChannelConnector = (signal?: AbortSignal) => Promise<Channel>;

export function createWebClients(
    connectChannel: WebChannelConnector = connectBrowserWebSocketChannel,
): WebClients {
    return createPersistentControlClients({
        clientKind: "web",
        connectChannel,
        mapError,
        mapRemoteError: (error) => createError(error),
        peer: "web",
    });
}

function mapError(error: unknown): Error {
    if (isControlErrorBody(error)) return createError(error);
    return error instanceof Error ? error : new Error(String(error));
}

function isControlErrorBody(value: unknown): value is ControlErrorBody {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const body = value as Partial<ControlErrorBody>;
    return typeof body.code === "string" &&
        typeof body.message === "string" &&
        typeof body.retryable === "boolean";
}
