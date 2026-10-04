import {
    McpHost,
    McpRuntimeState,
    resolvePortableDevshellApplicationVersion,
    type McpOAuthApprovalConfig,
    type McpToolProvenanceRecorder,
} from "@portable-devshell/mcp";
import type { ControlConfig } from "@portable-devshell/shared";

import type { InstanceRegistry } from "@portable-devshell/core";
import { McpEndpointFactory } from "./Endpoint.js";

export class McpRuntimeFactory {
    readonly #mapper: McpEndpointFactory;
    readonly #serverVersion?: string;

    constructor(options?: {
        mapper?: McpEndpointFactory;
        serverVersion?: string;
    }) {
        this.#mapper = options?.mapper ?? new McpEndpointFactory();
        this.#serverVersion = options?.serverVersion;
    }

    wire(
        config: ControlConfig,
        registry: InstanceRegistry,
        options?: {
            runtimeState?: McpRuntimeState;
            storageDir?: string;
            toolProvenance?: McpToolProvenanceRecorder;
            mcpAppLeaseFile?: string;
        },
    ): McpHost | undefined {
        if (!config.mcp.enabled) {
            return undefined;
        }

        const endpoints = config.mcp.enabled
            ? registry
                  .list()
                  .filter((descriptor) => descriptor.mcpEnabled)
                  .map((descriptor) => {
                      const instance = config.instances.find(
                          (entry) => entry.name === descriptor.name,
                      );
                      if (instance === undefined)
                          throw new Error(
                              `Missing config for MCP instance ${descriptor.name}.`,
                          );
                      return this.#mapper.map(
                          descriptor,
                          instance.mcp.auth,
                          instance.workspace.enabled,
                      );
                  })
            : [];

        if (options?.runtimeState === undefined)
            throw new Error("MCP requires the Control-owned Context runtime.");
        return new McpHost(
            {
                instances: endpoints,
                listenHost: config.mcp.listenHost,
                listenPort: config.mcp.listenPort,
                oauthApproval: toMcpOAuthApprovalConfig(config.mcp.oauth2),
                publicBaseUrl: config.mcp.publicBaseUrl,
                serverVersion:
                    this.#serverVersion ??
                    resolvePortableDevshellApplicationVersion(),
                ...(options?.storageDir === undefined
                    ? {}
                    : { storageDir: options.storageDir }),
                ...(options?.toolProvenance === undefined
                    ? {}
                    : { toolProvenance: options.toolProvenance }),
                ...(options?.mcpAppLeaseFile === undefined
                    ? {}
                    : {
                          mcpAppLeaseFile: options.mcpAppLeaseFile,
                      }),
            },
            options.runtimeState,
        );
    }
}

export function toMcpOAuthApprovalConfig(
    config: ControlConfig["mcp"]["oauth2"],
): McpOAuthApprovalConfig {
    return config.approval === "tui"
        ? { mode: "tui" }
        : {
              mode: "token",
              ...(config.token === undefined ? {} : { token: config.token }),
          };
}
