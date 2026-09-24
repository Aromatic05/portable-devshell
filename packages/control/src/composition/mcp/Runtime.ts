import {
    McpHost,
    McpRuntimeState,
    resolvePortableDevshellApplicationVersion,
    type McpInstanceGateway,
    type McpOAuthApprovalConfig,
    type McpToolProvenanceRecorder,
} from "@portable-devshell/mcp";
import type { ControlConfig } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../control/instance/registry/Registry.js";
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
            contextFile?: string;
            gateway?: McpInstanceGateway;
            runtimeState?: McpRuntimeState;
            storageDir?: string;
            toolProvenance?: McpToolProvenanceRecorder;
            workspaceAppLeaseFile?: string;
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
                          options?.gateway,
                          instance.mcp.auth,
                          instance.workspace.enabled,
                      );
                  })
            : [];

        return new McpHost(
            {
                ...(options?.contextFile === undefined
                    ? {}
                    : { contextFile: options.contextFile }),
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
                ...(options?.workspaceAppLeaseFile === undefined
                    ? {}
                    : {
                          workspaceAppLeaseFile:
                              options.workspaceAppLeaseFile,
                      }),
            },
            options?.runtimeState,
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
