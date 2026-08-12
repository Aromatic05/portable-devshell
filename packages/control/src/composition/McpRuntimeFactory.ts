import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpHost, type McpInstanceGateway } from "@portable-devshell/mcp";
import type { ControlConfig } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../control/instance/registry/InstanceRegistry.js";
import { McpEndpointFactory } from "./McpEndpointFactory.js";

export class McpRuntimeFactory {
    readonly #mapper: McpEndpointFactory;
    readonly #serverVersion?: string;

    constructor(options?: { mapper?: McpEndpointFactory; serverVersion?: string }) {
        this.#mapper = options?.mapper ?? new McpEndpointFactory();
        this.#serverVersion = options?.serverVersion;
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
            serverVersion: this.#serverVersion ?? resolveApplicationVersion(),
            storageDir: options?.storageDir
        });
    }
}

function resolveApplicationVersion(): string {
    let directory = dirname(fileURLToPath(import.meta.url));
    while (true) {
        const manifestPath = join(directory, "package.json");
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                name?: unknown;
                version?: unknown;
            };
            if (manifest.name === "portable-devshell") {
                if (typeof manifest.version !== "string" || manifest.version.length === 0) {
                    throw new Error(`Application package version is invalid: ${manifestPath}`);
                }
                return manifest.version;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error("Cannot locate portable-devshell application package manifest.");
}
