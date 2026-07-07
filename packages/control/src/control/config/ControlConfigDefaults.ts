import type { ControlConfig } from "./ControlConfigTomlCodec.js";

export function createDefaultControlConfig(): ControlConfig {
    return {
        control: {
            logLevel: "info"
        },
        instances: [],
        mcp: {
            auth: {
                mode: "none"
            },
            enabled: false,
            listenHost: "127.0.0.1",
            listenPort: 17890,
            publicBaseUrl: "http://127.0.0.1:17890"
        },
        version: 1
    };
}
