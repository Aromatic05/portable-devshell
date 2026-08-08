import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { HttpHost } from "@portable-devshell/mcp";
import {
    CONTROL_REMOTE_RPC_PATH,
    CONTROL_REMOTE_RPC_SUBPROTOCOL,
    CONTROL_WEB_BASE_PATH,
    WebSocketServerChannel,
    type Channel,
} from "@portable-devshell/shared";
import { TRANSPORT_MAX_FRAME_SIZE } from "@portable-devshell/shared/transport/frame";
import { WebSocketServer } from "ws";

import type {
    ControlAcceptedChannel,
    ControlChannelListener,
} from "../channel/ControlChannelServer.js";
import { ControlWebSessionService } from "./ControlWebSessionService.js";
import {
    ControlWebSocketSessionAccess,
    type ControlWebSocketAccess,
    type ControlWebSocketAccessAuthorizer
} from "./ControlWebSocketAccessService.js";

export interface ControlWebSocketListenerOptions {
    access?: ControlWebSocketAccessAuthorizer;
    assetDirectory?: string;
    basePath?: string;
    http: HttpHost;
    path?: string;
    remotePath?: string | false;
    sessions: ControlWebSessionService;
}

export class ControlWebSocketListener implements ControlChannelListener {
    readonly #access: ControlWebSocketAccessAuthorizer;
    readonly #assetDirectory?: string;
    readonly #basePath: string;
    readonly #channelsByAccess = new Map<string, Set<Channel>>();
    readonly #http: HttpHost;
    readonly #paths: Array<{
        accessKind: ControlWebSocketAccess["kind"];
        path: string;
    }>;
    readonly #sessions: ControlWebSessionService;
    #unsubscribeRevocation?: () => void;
    #accept?: (connection: ControlAcceptedChannel) => void;
    #removeRoutes?: () => void;
    #routesInstalled = false;
    #started = false;
    #webSocketServer?: WebSocketServer;

    constructor(options: ControlWebSocketListenerOptions) {
        this.#assetDirectory = options.assetDirectory;
        this.#basePath = normalizeBasePath(options.basePath ?? CONTROL_WEB_BASE_PATH);
        this.#http = options.http;
        this.#sessions = options.sessions;
        this.#access = options.access ?? new ControlWebSocketSessionAccess(options.sessions);
        const browserPath = normalizeAbsolutePath(
            options.path ?? `${this.#basePath}/rpc`,
        );
        const remotePath = options.remotePath ?? (options.access === undefined
            ? false
            : CONTROL_REMOTE_RPC_PATH);
        const normalizedRemotePath = remotePath === false
            ? undefined
            : normalizeAbsolutePath(remotePath);
        if (normalizedRemotePath === browserPath) {
            throw new Error(
                "Control browser and native WebSocket paths must be distinct.",
            );
        }
        this.#paths = [
            { accessKind: "browser", path: browserPath },
            ...(normalizedRemotePath === undefined
                ? []
                : [{ accessKind: "native" as const, path: normalizedRemotePath }]),
        ];
    }

    async start(accept: (connection: ControlAcceptedChannel) => void): Promise<void> {
        if (this.#started) return;
        this.#accept = accept;
        this.#unsubscribeRevocation = this.#access.onRevoked((key) => {
            this.#closeAccessChannels(key);
        });
        if (!this.#routesInstalled) {
            const removeRoutes = [this.#sessions.install(this.#http)];
            if (this.#assetDirectory !== undefined) {
                removeRoutes.push(
                    this.#http.registerStaticDirectory(this.#basePath, this.#assetDirectory)
                );
            }
            for (const route of this.#paths) {
                removeRoutes.push(this.#http.registerUpgradeHandler(
                    route.path,
                    async (request, socket, head) => {
                        await this.#handleUpgrade(
                            request,
                            socket,
                            head,
                            route.accessKind,
                        );
                    }
                ));
            }
            this.#removeRoutes = () => {
                for (const remove of removeRoutes.reverse()) remove();
            };
            this.#routesInstalled = true;
        }
        this.#webSocketServer = new WebSocketServer({
            clientTracking: true,
            handleProtocols: (protocols) => protocols.has(CONTROL_REMOTE_RPC_SUBPROTOCOL)
                ? CONTROL_REMOTE_RPC_SUBPROTOCOL
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
        this.#unsubscribeRevocation?.();
        this.#unsubscribeRevocation = undefined;
        this.#channelsByAccess.clear();
        this.#removeRoutes?.();
        this.#removeRoutes = undefined;
        this.#routesInstalled = false;
        const server = this.#webSocketServer;
        this.#webSocketServer = undefined;
        if (server === undefined) return;
        for (const socket of server.clients) {
            socket.close(1001, "control server stopping");
            socket.terminate();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    async #handleUpgrade(
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        expectedAccessKind: ControlWebSocketAccess["kind"],
    ): Promise<void> {
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
        const access = await this.#access.authorize(request);
        if (access === undefined || access.kind !== expectedAccessKind) {
            writeUpgradeError(socket, 401, "Unauthorized");
            return;
        }
        if (access.expiresAtMs !== undefined && access.expiresAtMs <= Date.now()) {
            writeUpgradeError(socket, 401, "Unauthorized");
            return;
        }
        if (!hasProtocol(request, CONTROL_REMOTE_RPC_SUBPROTOCOL)) {
            writeUpgradeError(socket, 426, "Upgrade Required", {
                "Sec-WebSocket-Protocol": CONTROL_REMOTE_RPC_SUBPROTOCOL
            });
            return;
        }
        server.handleUpgrade(request, socket, head, (webSocket) => {
            const channel = new WebSocketServerChannel(webSocket as never);
            this.#registerAccessChannel(access, channel);
            accept({
                admission: {
                    allowedPeers: access.kind === "browser"
                        ? ["web"]
                        : ["cli", "tui"],
                    subject: {
                        id: access.key,
                        kind: access.kind === "browser"
                            ? "web-session"
                            : "bearer",
                    },
                },
                channel,
            });
        });
    }

    #registerAccessChannel(access: ControlWebSocketAccess, channel: Channel): void {
        const channels = this.#channelsByAccess.get(access.key) ?? new Set();
        channels.add(channel);
        this.#channelsByAccess.set(access.key, channels);
        let expiryTimer: ReturnType<typeof setTimeout> | undefined;
        if (access.expiresAtMs !== undefined) {
            expiryTimer = setTimeout(() => {
                channel.close(new Error("Control client authorization expired."));
            }, Math.max(0, access.expiresAtMs - Date.now()));
            expiryTimer.unref?.();
        }
        channel.onClose(() => {
            if (expiryTimer !== undefined) clearTimeout(expiryTimer);
            channels.delete(channel);
            if (channels.size === 0) this.#channelsByAccess.delete(access.key);
        });
    }

    #closeAccessChannels(key: string): void {
        const channels = this.#channelsByAccess.get(key);
        if (channels === undefined) return;
        this.#channelsByAccess.delete(key);
        for (const channel of [...channels]) {
            channel.close(new Error("Control client authorization was revoked."));
        }
    }
}

function normalizeBasePath(value: string): string {
    if (!value.startsWith("/") || value === "/") {
        throw new Error("Control web basePath must be an absolute non-root path.");
    }
    return value.replace(/\/+$/u, "");
}

function normalizeAbsolutePath(value: string): string {
    if (!value.startsWith("/")) throw new Error("Control WebSocket path must be absolute.");
    return value.replace(/\/+$/u, "");
}

function hasProtocol(request: IncomingMessage, expected: string): boolean {
    const header = request.headers["sec-websocket-protocol"];
    const value = Array.isArray(header) ? header.join(",") : header;
    return value?.split(",").some((protocol) => protocol.trim() === expected) ?? false;
}

function hasSameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    const host = request.headers.host;
    if (host === undefined) return false;
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
