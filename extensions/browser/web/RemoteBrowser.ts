import { CONTROL_WEB_BASE_PATH, CONTROL_WEB_RPC_SUBPROTOCOL, Endpoint, WebChannel, ServerSession, createServerTransport, createPortClient, type WebSocketClientLike } from "@portable-devshell/shared";
import { WireDecoder, WireKind, decodeFrame } from "../src/Wire.js";

export interface Target { instance: string; profile: string }
export interface State { active: number; tabs: { index: number; url: string; title: string }[] }

function rpcUrl(): string {
    const segments = location.pathname.split("/");
    const index = segments.lastIndexOf(CONTROL_WEB_BASE_PATH.slice(1));
    const path = index < 0 ? CONTROL_WEB_BASE_PATH : segments.slice(0, index + 1).join("/");
    return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + path + "/rpc";
}

/** One UI connection; browser lifetime is managed independently by Control. */
export class RemoteBrowser {
    private readonly endpoint = new Endpoint({
        connectChannel: signal => WebChannel.connect({
            url: rpcUrl(), protocols: [CONTROL_WEB_RPC_SUBPROTOCOL],
            webSocketFactory: (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketClientLike,
        }, signal),
    });
    private readonly port = createPortClient(this.endpoint, "@control", "browser");
    private readonly server = new ServerSession(this.endpoint, createServerTransport(this.endpoint, { clientKind: "web" }));

    private async connect() {
        if (this.server.state.status !== "online") await this.server.connect();
        if (this.server.state.status !== "online") throw this.server.state.failure ?? new Error("Control is unavailable.");
    }
    private subscription?: AbortController;

    async request<T>(op: string, target?: Partial<Target>, args?: unknown): Promise<T> {
        await this.connect();
        return this.port.request<T>("request", { op, ...target, args });
    }

    stop(): void { this.subscription?.abort(); this.subscription = undefined; }

    async watch(target: Target, frame: (value: ReturnType<typeof decodeFrame>) => void): Promise<void> {
        this.stop();
        const controller = this.subscription = new AbortController();
        await this.connect();
        const stream = await this.port.open("frames", target, controller.signal);
        const decoder = new WireDecoder();
        try {
            while (!controller.signal.aborted) {
                const data = await stream.read();
                if (data === undefined) break;
                for (const record of decoder.push(data)) if (record.kind === WireKind.frame) frame(decodeFrame(record.data));
            }
        } finally { await stream.close(); }
    }
}
