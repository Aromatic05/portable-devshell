import type { ChannelProvider, FrameChannel } from "@portable-devshell/shared";
import { BrowserWebSocketChannel } from "./BrowserWebSocketChannel.js";
const protocol = "devshell-control-rpc.v1";

export class BrowserWebSocketChannelProvider implements ChannelProvider {
    constructor(private readonly url = rpcUrl(), private readonly factory: (url: string, protocols: string) => WebSocket = (value, protocols) => new WebSocket(value, protocols)) {}
    async connect(): Promise<FrameChannel> {
        const socket = this.factory(this.url, protocol);
        const channel = new BrowserWebSocketChannel(socket);
        return await new Promise<FrameChannel>((resolve, reject) => {
            const offClose = channel.onClose((error) => { offOpen(); reject(error ?? new Error("WebSocket connection closed.")); });
            const offOpen = () => { socket.removeEventListener("open", opened); };
            const opened = () => { offOpen(); offClose(); resolve(channel); };
            socket.addEventListener("open", opened);
        });
    }
}
export function rpcUrl(location: Location = window.location): string {
    const override = import.meta.env.VITE_DEVSHELL_RPC_URL;
    if (override) return override;
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/web/rpc`;
}
