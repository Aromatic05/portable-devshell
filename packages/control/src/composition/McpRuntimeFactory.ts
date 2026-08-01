import { McpHost, type McpInstanceGateway } from "@portable-devshell/mcp";
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

        const endpoints = config.mcp.enabled
            ? registry
                  .list()
                  .filter((descriptor) => descriptor.mcpEnabled)
                  .map((descriptor) => {
                      const instance = config.instances.find((entry) => entry.name === descriptor.name);
                      if (instance === undefined) throw new Error(`Missing config for MCP instance ${descriptor.name}.`);
                      return this.#mapper.map(descriptor, options?.gateway, instance.mcp.auth);
                  })
            : [];

        return new McpHost({
            ...(options?.contextFile === undefined ? {} : { contextFile: options.contextFile }),
            instances: endpoints,
            listenHost: config.mcp.listenHost,
            listenPort: config.mcp.listenPort,
            publicBaseUrl: config.mcp.publicBaseUrl,
            storageDir: options?.storageDir
        });
    }
}
