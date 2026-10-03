// Control service handshake model. The protocol version, negotiated
// capabilities, and the client surfaces that establish a control session are
// owned by the service subdomain; the service status summary is the control
// host's own health report.

export const CONTROL_PROTOCOL_VERSION = "1.0.0";
export const CONTROL_PROTOCOL_RANGE = Object.freeze({
    max: CONTROL_PROTOCOL_VERSION,
    min: CONTROL_PROTOCOL_VERSION,
});

/** Client surfaces that establish a control session. */
export type ControlClientKind = "cli" | "tui" | "web";

/** Optional behaviors a control peer can negotiate during the handshake. */
export type ControlProtocolCapability = "request" | "stream" | "streamResume";

export interface ControlProtocolHelloResponse {
    capabilities: ControlProtocolCapability[];
    protocolVersion: string;
}

export interface ControlServiceStatus {
    instanceCount: number;
    ok: boolean;
    pid?: number;
}
