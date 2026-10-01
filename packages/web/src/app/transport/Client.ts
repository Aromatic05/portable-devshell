import {
    createPersistentControlClients,
    type Channel,
    type InstanceEventStream,
    type McpRuntimeStatus,
    type PersistentControlClients,
} from "@portable-devshell/shared/browser";

import { connectBrowserWebChannel } from "./Socket.js";

export type WebClients = PersistentControlClients;
export type WebRuntimeStream = InstanceEventStream;
export type McpStatus = McpRuntimeStatus;
export type WebChannelConnector = (signal?: AbortSignal) => Promise<Channel>;

export function createWebClients(
    connectChannel: WebChannelConnector = connectBrowserWebChannel,
): WebClients {
    return createPersistentControlClients({
        clientKind: "web",
        connectChannel,
    });
}
