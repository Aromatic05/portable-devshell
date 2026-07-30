import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { McpHostHttpServer } from "@portable-devshell/mcp";
import {
    CONTROL_WEB_RPC_PATH,
    CONTROL_WEB_RPC_SUBPROTOCOL
} from "@portable-devshell/shared";
import { TRANSPORT_MAX_FRAME_SIZE } from "@portable-devshell/shared/transport/frame";
import { WebSocketServer } from "ws";

import type { ControlChannelProvider } from "../channel/ControlChannelServer.js";
import { ControlWebSessionService } from "./ControlWebSessionService.js";
import { ControlWebSocketFrameChannel } from "./ControlWebSocketFrameChannel.js";

export interface ControlWebSocketChannelProviderOptions {
    assetDirectory?: string;
    http: McpHostHttpServer;
    path?: string;
    sessions: ControlWebSessionService;
}

export class ControlWebSocketChannelProvider implements ControlChannelProvider {
    readonly #assetDirectory?: string;
    readonly #http: McpHostHttpServer;
    readonly #path: string;
    readonly #sessions: ControlWebSessionService;
    #accept?: (channel: ControlWebSocketFrameChannel) => void;
    #routesInstalled = false;
    #started = false;
    #webSocketServer?: WebSocketServer;

    constructor(options: ControlWebSocketChannelProviderOptions) {
        this.#assetDirectory = options.assetDirectory;
        this.#http = options.http;
        this.#path = options.path ?? CONTROL_WEB_RPC_PATH;
        this.#sessions = options.sessions;
    }

    async start(accept: (channel: ControlWebSocketFrameChannel) => void): Promise<void> {
        if (this.#started) {
            return;
        }
        this.#accept = accept;
        if (!this.#routesInstalled) {
            this.#sessions.install(this.#http);
            if (this.#assetDirectory !== undefined) {
                this.#http.registerStaticDirectory("/web", this.#assetDirectory);
            }
            this.#http.registerUpgradeHandler(this.#path, async (request, socket, head) => {
                await this.#handleUpgrade(request, socket, head);
            });
            this.#routesInstalled = true;
        }
        this.#webSocketServer = new WebSocketServer({
            clientTracking: true,
            handleProtocols: (protocols) => protocols.has(CONTROL_WEB_RPC_SUBPROTOCOL)
                ? CONTROL_WEB_RPC_SUBPROTOCOL
                : false,
            maxPayload: TRANSPORT_MAX_FRAME_SIZE,
            noServer: true
        });
        this.#started = true;
    }

    async close(): Promise<void> {
        this.#started = false;
        this.#accept = undefined;
        this.#sessions.clear();
        const server = this.#webSocketServer;
        this.#webSocketServer = undefined;
        if (server === undefined) {
            return;
        }
        for (const socket of server.clients) {
            socket.close(1001, "control server stopping");
            socket.terminate();
        }
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }

    async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        const server = this.#webSocketServer;
        const accept = this.#accept;
        if (!this.#started || server === undefined || accept === undefined) {
            writeUpgradeError(socket, 503, "Service Unavailable");
            return;
        }
        if (!hasSameOrigin(request)) {
            writeUpgradeError(socket, 403, "Forbidden");
            return;
        }
        if (!this.#sessions.authorize(request)) {
            writeUpgradeError(socket, 401, "Unauthorized");
            return;
        }
        if (!hasProtocol(request, CONTROL_WEB_RPC_SUBPROTOCOL)) {
            writeUpgradeError(socket, 426, "Upgrade Required", {
                "Sec-WebSocket-Protocol": CONTROL_WEB_RPC_SUBPROTOCOL
            });
            return;
        }
        server.handleUpgrade(request, socket, head, (webSocket) => {
            accept(new ControlWebSocketFrameChannel(webSocket));
        });
    }
}

function hasProtocol(request: IncomingMessage, expected: string): boolean {
    const header = request.headers["sec-websocket-protocol"];
    const value = Array.isArray(header) ? header.join(",") : header;
    return value?.split(",").some((protocol) => protocol.trim() === expected) ?? false;
}

function hasSameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) {
        return true;
    }
    const host = request.headers.host;
    if (host === undefined) {
        return false;
    }
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

function writeUpgradeError(
    socket: Duplex,
    statusCode: number,
    statusText: string,
    headers: Record<string, string> = {}
): void {
    const lines = [
        `HTTP/1.1 ${statusCode} ${statusText}`,
        "Connection: close",
        "Content-Length: 0",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        ""
    ];
    socket.end(lines.join("\r\n"));
}
