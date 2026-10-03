import {
    CONTROL_WEB_RPC_SUBPROTOCOL,
    WebChannel,
    type Channel,
    type WebSocketClientLike,
} from "@portable-devshell/shared";

import { webRoutePath } from "./Route.js";

export type BrowserWebSocketFactory = (
    url: string,
    protocols: string[],
) => WebSocket;

export async function connectBrowserWebChannel(
    signal?: AbortSignal,
    url = rpcUrl(),
    factory: BrowserWebSocketFactory = (value, protocols) =>
        new WebSocket(value, protocols),
): Promise<Channel> {
    return await WebChannel.connect(
        {
            protocols: [CONTROL_WEB_RPC_SUBPROTOCOL],
            url,
            webSocketFactory: (value, protocols) =>
                factory(value, protocols) as unknown as WebSocketClientLike,
        },
        signal,
    );
}

export function rpcUrl(location: Location = window.location): string {
    const override = import.meta.env.VITE_DEVSHELL_RPC_URL;
    if (override) return override;
    const path = webRoutePath(location.pathname, "/rpc");
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
}
