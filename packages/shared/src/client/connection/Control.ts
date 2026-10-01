import type { Socket } from "node:net";

import type { Channel } from "../../transport/endpoint/channel/Channel.js";

const CONTROL_REMOTE_RPC_PATH = "/control/v1/connect";

export const CONTROL_URL_ENV = "PORTABLE_DEVSHELL_CONTROL_URL";
export const CONTROL_TOKEN_ENV = "PORTABLE_DEVSHELL_CONTROL_TOKEN";

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
            await import("../../transport/endpoint/channel/Web.js");
        const token = options.controlToken ?? environment[CONTROL_TOKEN_ENV];
        return await WebChannel.connect(
            {
                ...(token === undefined || token.length === 0 ? {} : { token }),
                url: normalizeControlWebSocketUrl(configuredUrl),
            },
            signal,
        );
    }

    const [{ LocalChannel }, { resolveControlSocketPath }] = await Promise.all([
        import("../../transport/endpoint/channel/Local.js"),
        import("./LocalPath.js"),
    ]);
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

export function normalizeControlWebSocketUrl(value: string): string {
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

function isControlUnavailable(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "ECONNREFUSED" || code === "EPIPE";
}
