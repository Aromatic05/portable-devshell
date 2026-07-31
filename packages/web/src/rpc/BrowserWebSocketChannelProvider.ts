import {
    CONTROL_WEB_RPC_SUBPROTOCOL,
    type ChannelProvider,
    type FrameChannel,
} from "@portable-devshell/shared/browser";

import { webRoutePath } from "../routing/webRoute.js";
import { BrowserWebSocketChannel } from "./BrowserWebSocketChannel.js";

export class BrowserWebSocketChannelProvider implements ChannelProvider {
    constructor(
        private readonly url = rpcUrl(),
        private readonly factory: (
            url: string,
            protocols: string,
        ) => WebSocket = (value, protocols) => new WebSocket(value, protocols),
    ) {}

    async connect(signal?: AbortSignal): Promise<FrameChannel> {
        if (signal?.aborted === true) {
            throw abortError(signal);
        }
        const socket = this.factory(this.url, CONTROL_WEB_RPC_SUBPROTOCOL);
        const channel = new BrowserWebSocketChannel(socket);
        return await new Promise<FrameChannel>((resolve, reject) => {
            let settled = false;
            let offClose: () => void = () => undefined;
            const cleanup = () => {
                signal?.removeEventListener("abort", aborted);
                socket.removeEventListener("open", opened);
                offClose();
            };
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            const aborted = () => {
                const error = abortError(signal!);
                fail(error);
                try {
                    channel.close(error);
                } catch {
                    // The connection attempt is already rejected with the abort reason.
                }
            };
            const opened = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(channel);
            };
            offClose = channel.onClose((error) => {
                fail(error ?? new Error("WebSocket connection closed."));
            });
            signal?.addEventListener("abort", aborted, { once: true });
            socket.addEventListener("open", opened);
            if (signal?.aborted === true) aborted();
        });
    }
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("WebSocket connection was aborted.");
}

export function rpcUrl(location: Location = window.location): string {
    const override = import.meta.env.VITE_DEVSHELL_RPC_URL;
    if (override) return override;
    const path = webRoutePath(location.pathname, "/rpc");
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
}
