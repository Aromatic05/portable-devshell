import { McpHost, type McpAuthConfig } from "@portable-devshell/mcp";

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
            auth: toMcpHostAuth(config),
            instances: endpoints,
            listenHost: config.mcp.listenHost,
            listenPort: config.mcp.listenPort,
            publicBaseUrl: config.mcp.publicBaseUrl
        });
    }
}

function toMcpHostAuth(config: ControlConfig): McpAuthConfig | undefined {
    const mode = config.mcp.auth.mode;

    if (mode === "none") {
        return {
            enabled: false as const,
            provider: "none"
        };
    }

    if (mode === "oauth2") {
        if (config.mcp.auth.oauth2 === undefined) {
            throw new Error("mcp.auth.oauth2 is required when mcp.auth.mode=oauth2");
        }

        return {
            enabled: true as const,
            oauth2: {
                audience: config.mcp.auth.oauth2.audience,
                documentationUrl: config.mcp.auth.oauth2.documentationUrl,
                issuer: config.mcp.auth.oauth2.issuer,
                jwksUri: config.mcp.auth.oauth2.jwksUri,
                requiredScopes: [...config.mcp.auth.oauth2.requiredScopes],
                resourceName: config.mcp.auth.oauth2.resourceName
            },
            provider: "oauth2"
        };
    }

    return {
        enabled: true as const,
        provider: "token"
    };
}
