export const CONTROL_PROTOCOL_VERSION = 1;
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

export type ControlClientKind = "cli" | "tui" | "web";
export type ControlProtocolCapability = "request" | "stream" | "streamResume";

export interface ControlProtocolHelloRequest {
    clientKind: ControlClientKind;
    clientVersion?: string;
    maxProtocolVersion: number;
    minProtocolVersion: number;
}

export interface ControlProtocolHelloResponse {
    capabilities: ControlProtocolCapability[];
    protocolVersion: number;
}
