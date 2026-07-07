import { McpHost } from "@portable-devshell/mcp";

import type { ControlConfig } from "../control/config/ControlConfigTomlCodec.js";
import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import { McpEndpointConfigMapper } from "./McpEndpointConfigMapper.js";

export class McpWiringService {
    readonly #mapper: McpEndpointConfigMapper;

    constructor(options?: { mapper?: McpEndpointConfigMapper }) {
        this.#mapper = options?.mapper ?? new McpEndpointConfigMapper();
    }

    wire(config: ControlConfig, registry: InstanceRegistry): McpHost | undefined {
        if (!config.mcp.enabled) {
            return undefined;
        }

        const endpoints = registry
            .list()
            .filter((descriptor) => descriptor.mcpEnabled)
            .map((descriptor) => this.#mapper.map(descriptor));

        return new McpHost({
            auth: toMcpHostAuth(config.mcp.auth.mode),
            instances: endpoints,
            listenHost: config.mcp.listenHost,
            listenPort: config.mcp.listenPort,
            publicBaseUrl: config.mcp.publicBaseUrl
        });
    }
}

function toMcpHostAuth(mode: "none" | "oauth2" | "token"): { enabled: boolean; provider: string } | undefined {
    if (mode === "none") {
        return {
            enabled: false,
            provider: "none"
        };
    }

    return {
        enabled: true,
        provider: mode
    };
}
