import { McpHost, type McpAuthConfig, type McpInstanceGateway } from "@portable-devshell/mcp";
import type { ControlConfig } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../control/instance/registry/InstanceRegistry.js";
import { McpEndpointFactory } from "./McpEndpointFactory.js";

export class McpRuntimeFactory {
    readonly #mapper: McpEndpointFactory;

    constructor(options?: { mapper?: McpEndpointFactory }) {
        this.#mapper = options?.mapper ?? new McpEndpointFactory();
    }

    wire(
        config: ControlConfig,
        registry: InstanceRegistry,
        options?: { contextFile?: string; gateway?: McpInstanceGateway; storageDir?: string }
    ): McpHost | undefined {
        if (!config.mcp.enabled) {
            return undefined;
        }

        const endpoints = registry
            .list()
            .filter((descriptor) => descriptor.mcpEnabled)
            .map((descriptor) => this.#mapper.map(descriptor, options?.gateway));

        return new McpHost({
            auth: toMcpHostAuth(config),
            ...(options?.contextFile === undefined ? {} : { contextFile: options.contextFile }),
            instances: endpoints,
            listenHost: config.mcp.listenHost,
            listenPort: config.mcp.listenPort,
            publicBaseUrl: config.mcp.publicBaseUrl,
            storageDir: options?.storageDir
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
                documentationUrl: config.mcp.auth.oauth2.documentationUrl,
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
