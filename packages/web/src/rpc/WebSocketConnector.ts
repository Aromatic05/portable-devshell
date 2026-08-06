import {
    CONTROL_WEB_RPC_SUBPROTOCOL,
    WebSocketChannel,
    type Channel,
    type WebSocketClientLike,
} from "@portable-devshell/shared/browser";

import { webRoutePath } from "../routing/webRoute.js";

export type BrowserWebSocketFactory = (
    url: string,
    protocols: string[],
) => WebSocket;

export async function connectBrowserWebSocketChannel(
    signal?: AbortSignal,
    url = rpcUrl(),
    factory: BrowserWebSocketFactory = (value, protocols) =>
        new WebSocket(value, protocols),
): Promise<Channel> {
    return await WebSocketChannel.connect(
        {
            subprotocol: CONTROL_WEB_RPC_SUBPROTOCOL,
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
