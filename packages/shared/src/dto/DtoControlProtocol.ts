export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_WEB_RPC_PATH = "/web/rpc";
export const CONTROL_WEB_RPC_SUBPROTOCOL = "devshell-control-rpc.v1";
export const CONTROL_WEB_SESSION_PATH = "/web/session";

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
