import type { Socket } from "node:net";

import type { Channel } from "../transport/endpoint/channel/Channel.js";
import { resolveControlSocketPath } from "./Path.js";

// Control transport routing constants. These describe how a client reaches the
// control host; the handshake vocabulary lives in ../service/Model.ts.
export const CONTROL_HOST = "@control";
export const CONTROL_WEB_BASE_PATH = "/web";
export const CONTROL_WEB_RPC_PATH = "/web/rpc";
export const CONTROL_REMOTE_RPC_PATH = "/control/v1/connect";
export const CONTROL_REMOTE_RPC_SUBPROTOCOL = "devshell-control-rpc.v1";
export const CONTROL_REMOTE_BEARER_SUBPROTOCOL_PREFIX = "devshell-bearer.";
export const CONTROL_WEB_RPC_SUBPROTOCOL = CONTROL_REMOTE_RPC_SUBPROTOCOL;
export const CONTROL_WEB_SESSION_PATH = "/web/session";

export function controlRemoteRpcPath(publicBaseUrl?: string): string {
    if (publicBaseUrl === undefined) return CONTROL_REMOTE_RPC_PATH;
    const pathname = new URL(publicBaseUrl).pathname;
    const prefix = pathname === "/" ? "" : pathname.replace(/\/+$/u, "");
    return `${prefix}${CONTROL_REMOTE_RPC_PATH}`;
}

export function controlWebBasePath(publicBaseUrl?: string): string {
    if (publicBaseUrl === undefined) {
        return CONTROL_WEB_BASE_PATH;
    }
    const pathname = new URL(publicBaseUrl).pathname;
    const prefix = pathname === "/" ? "" : pathname.replace(/\/+$/u, "");
    return `${prefix}${CONTROL_WEB_BASE_PATH}`;
}

const CONTROL_URL_ENV = "PORTABLE_DEVSHELL_CONTROL_URL";
const CONTROL_TOKEN_ENV = "PORTABLE_DEVSHELL_CONTROL_TOKEN";

export interface ControlChannelOptions {
    connectChannel?(signal?: AbortSignal): Promise<Channel>;
    controlToken?: string;
    controlUrl?: string;
    environment?: NodeJS.ProcessEnv;
    socketFactory?: (path: string) => Socket;
    socketPath?: string;
    xdgRuntimeDir?: string;
}

export async function connectControlChannel(
    options: ControlChannelOptions = {},
    signal?: AbortSignal,
): Promise<Channel> {
    if (options.connectChannel !== undefined)
        return await options.connectChannel(signal);

    const environment = options.environment ?? process.env;
    const configuredUrl = options.controlUrl ?? environment[CONTROL_URL_ENV];
    if (configuredUrl !== undefined && configuredUrl.trim().length > 0) {
        const { WebChannel } =
            await import("../transport/endpoint/channel/Web.js");
        const token = options.controlToken ?? environment[CONTROL_TOKEN_ENV];
        return await WebChannel.connect(
            {
                protocols: controlWebSocketProtocols(token),
                url: normalizeControlWebSocketUrl(configuredUrl),
            },
            signal,
        );
    }

    const { LocalChannel } =
        await import("../transport/endpoint/channel/Local.js");
    try {
        return await LocalChannel.connect(
            options.socketPath ??
                resolveControlSocketPath(options.xdgRuntimeDir),
            {
                signal,
                ...(options.socketFactory === undefined
                    ? {}
                    : { socketFactory: options.socketFactory }),
            },
        );
    } catch (error) {
        if (!isControlUnavailable(error)) throw error;
        throw Object.assign(new Error("Control server is not running."), {
            code: "control.notRunning",
            retryable: true,
        });
    }
}

function normalizeControlWebSocketUrl(value: string): string {
    const url = new URL(value);
    if (url.username.length > 0 || url.password.length > 0)
        throw new Error("Control URL must not contain embedded credentials.");
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol !== "ws:" && url.protocol !== "wss:")
        throw new Error("Control URL must use http, https, ws, or wss.");
    url.search = "";
    url.hash = "";
    const base = url.pathname.replace(/\/+$/u, "");
    if (!base.endsWith(CONTROL_REMOTE_RPC_PATH))
        url.pathname =
            `${base}${CONTROL_REMOTE_RPC_PATH}` || CONTROL_REMOTE_RPC_PATH;
    return url.href;
}

export function controlWebSocketProtocols(token?: string): string[] {
    return [
        CONTROL_REMOTE_RPC_SUBPROTOCOL,
        ...(token === undefined || token.length === 0
            ? []
            : [
                  CONTROL_REMOTE_BEARER_SUBPROTOCOL_PREFIX +
                      encodeBase64Url(token),
              ]),
    ];
}

function isControlUnavailable(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE";
}

function encodeBase64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let result = "";
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index]!;
        const second = bytes[index + 1];
        const third = bytes[index + 2];
        const bits = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
        result += alphabet[(bits >>> 18) & 0x3f];
        result += alphabet[(bits >>> 12) & 0x3f];
        if (second !== undefined) result += alphabet[(bits >>> 6) & 0x3f];
        if (third !== undefined) result += alphabet[bits & 0x3f];
    }
    return result;
}
