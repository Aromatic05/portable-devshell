import type { CommandResult, JsonValue } from "@portable-devshell/shared";
import { McpAuthPublicExposureGuard, type McpExposureConfig } from "../auth/public/McpAuthPublicExposureGuard.js";
import { McpEndpointBinding } from "../endpoint/McpEndpointBinding.js";
import { McpEndpointWorker } from "../endpoint/McpEndpointWorker.js";
import { McpHostHttpServer } from "./McpHostHttpServer.js";
import { McpHostRouteMatcher } from "./route/McpHostRouteMatcher.js";
import { McpHostRouteRegistry } from "./route/McpHostRouteRegistry.js";

interface ToolDefinition {
    description?: string;
    inputSchema?: JsonValue;
    name: string;
}

interface WorkerInstanceLike {
    callTool(toolName: string, input: JsonValue, context: { requestId?: string; sessionId?: string; source: "mcp" }): Promise<CommandResult>;
    hasToolSchemaCache?(): boolean;
    listTools(): ToolDefinition[];
    snapshot(): { ready?: boolean };
}

export interface McpHostInstanceConfig {
    allowlist: readonly string[];
    name: string;
    worker: WorkerInstanceLike;
}

export interface McpHostConfig extends McpExposureConfig {
    instances: readonly McpHostInstanceConfig[];
    listenPort: number;
}

export class McpHost {
    readonly #config: McpHostConfig;
    readonly #guard = new McpAuthPublicExposureGuard();
    readonly #httpServer: McpHostHttpServer;
    readonly #registry = new McpHostRouteRegistry();

    constructor(config: McpHostConfig) {
        this.#config = config;

        for (const instance of config.instances) {
            this.registerInstance(instance);
        }

        this.#httpServer = new McpHostHttpServer({
            auth: config.auth,
            listenHost: config.listenHost,
            listenPort: config.listenPort,
            matcher: new McpHostRouteMatcher(),
            registry: this.#registry
        });
    }

    async start(): Promise<void> {
        this.#guard.assertSafe(this.#config);
        await this.#httpServer.start();
    }

    async stop(): Promise<void> {
        await this.#httpServer.stop();
        await Promise.all(this.#registry.list().map(async (binding) => await binding.close()));
    }

    registerInstance(instance: McpHostInstanceConfig): void {
        this.#registry.register(
            new McpEndpointBinding(
                new McpEndpointWorker({
                    allowlist: instance.allowlist,
                    instanceName: instance.name,
                    worker: instance.worker
                })
            )
        );
    }

    get server(): McpHostHttpServer {
        return this.#httpServer;
    }
}
