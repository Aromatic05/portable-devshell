import type { Socket } from "node:net";

import { CONTROL_REMOTE_RPC_PATH } from "../dto/DtoControlProtocol.js";
import type { Channel } from "../transport/protocol/Channel.js";
import type { ClientConnectionOptions } from "../transport/ClientConnection.js";

export const CONTROL_URL_ENV = "PORTABLE_DEVSHELL_CONTROL_URL";
export const CONTROL_TOKEN_ENV = "PORTABLE_DEVSHELL_CONTROL_TOKEN";

export interface ControlClientChannelOptions {
    connectChannel?: ClientConnectionOptions["connectChannel"];
    controlToken?: string;
    controlUrl?: string;
    environment?: NodeJS.ProcessEnv;
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export type ControlClientEndpoint =
    | {
          kind: "socket";
          socketFactory?: (path: string) => Socket;
          socketPath?: string;
          xdgRuntimeDir?: string;
      }
    | {
          kind: "websocket";
          token?: string;
          url: string;
      };

export async function connectControlClientChannel(
    options: ControlClientChannelOptions = {},
    signal?: AbortSignal,
): Promise<Channel> {
    if (options.connectChannel !== undefined) {
        return await options.connectChannel(signal);
    }
    const endpoint = resolveControlClientEndpoint(options);
    if (endpoint.kind === "websocket") {
        const { WebSocketChannel } = await import(
            "../transport/websocket/WebSocketChannel.js"
        );
        return await WebSocketChannel.connect(
            {
                ...(endpoint.token === undefined
                    ? {}
                    : { token: endpoint.token }),
                url: endpoint.url,
            },
            signal,
        );
    }
    const [{ SocketChannel }, { resolveControlSocketPath }] =
        await Promise.all([
            import("../transport/socket/SocketChannel.js"),
            import("../transport/socket/Endpoint.js"),
        ]);
    return await SocketChannel.connect(
        endpoint.socketPath ??
            resolveControlSocketPath(endpoint.xdgRuntimeDir),
        {
            signal,
            ...(endpoint.socketFactory === undefined
                ? {}
                : { socketFactory: endpoint.socketFactory }),
        },
    );
}

export function resolveControlClientEndpoint(
    options: Omit<ControlClientChannelOptions, "connectChannel"> = {},
): ControlClientEndpoint {
    const environment =
        options.environment ??
        (typeof process === "undefined" ? {} : process.env);
    const configuredUrl = options.controlUrl ?? environment[CONTROL_URL_ENV];
    if (configuredUrl !== undefined && configuredUrl.trim().length > 0) {
        const token = options.controlToken ?? environment[CONTROL_TOKEN_ENV];
        return {
            kind: "websocket",
            ...(token === undefined || token.length === 0 ? {} : { token }),
            url: normalizeControlWebSocketUrl(configuredUrl),
        };
    }
    return {
        kind: "socket",
        ...(options.socketFactory === undefined
            ? {}
            : { socketFactory: options.socketFactory }),
        ...(options.socketPath === undefined
            ? {}
            : { socketPath: options.socketPath }),
        ...(options.xdgRuntimeDir === undefined
            ? {}
            : { xdgRuntimeDir: options.xdgRuntimeDir }),
    };
}

export function normalizeControlWebSocketUrl(value: string): string {
    const url = new URL(value);
    if (url.username.length > 0 || url.password.length > 0) {
        throw new Error("Control URL must not contain embedded credentials.");
    }
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        throw new Error("Control URL must use http, https, ws, or wss.");
    }
    url.search = "";
    url.hash = "";
    const base = url.pathname.replace(/\/+$/u, "");
    if (!base.endsWith(CONTROL_REMOTE_RPC_PATH)) {
        url.pathname =
            `${base}${CONTROL_REMOTE_RPC_PATH}` || CONTROL_REMOTE_RPC_PATH;
    }
    return url.href;
}
