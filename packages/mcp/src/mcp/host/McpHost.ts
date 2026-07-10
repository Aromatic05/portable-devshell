import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";
import { type McpAuthConfig } from "../auth/McpAuthConfig.js";
import { McpOAuthProtectedResource } from "../auth/oauth/McpOAuthProtectedResource.js";
import type { McpOAuthApprovalService } from "../auth/oauth/McpOAuthApprovalService.js";
import { McpAuthPublicExposureGuard, type McpExposureConfig } from "../auth/public/McpAuthPublicExposureGuard.js";
import { McpEndpointBinding } from "../endpoint/McpEndpointBinding.js";
import { McpEndpointWorker } from "../endpoint/McpEndpointWorker.js";
import { McpHostHttpServer } from "./McpHostHttpServer.js";
import { McpHostRouteRegistry } from "./route/McpHostRouteRegistry.js";

interface WorkerInstanceLike {
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(toolName: string, context: { requestId?: string; sessionId?: string }): Promise<void>;
    callTool(toolName: string, input: JsonValue, context: { requestId?: string; sessionId?: string; source: "mcp" }): Promise<JsonValue>;
    hasToolSchemaCache?(): boolean;
    listTools(): ToolDefinition[];
    snapshot(): { ready?: boolean };
}

export interface McpHostInstanceConfig {
    allowlist: readonly string[];
    name: string;
    path?: string;
    worker: WorkerInstanceLike;
}

export interface McpHostConfig extends McpExposureConfig {
    auth?: McpAuthConfig;
    instances: readonly McpHostInstanceConfig[];
    listenPort: number;
    storageDir?: string;
}

export class McpHost {
    readonly #auth?: McpAuthConfig;
    readonly #config: McpHostConfig;
    readonly #guard = new McpAuthPublicExposureGuard();
    readonly #httpServer: McpHostHttpServer;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #registry = new McpHostRouteRegistry();
    #started = false;

    constructor(config: McpHostConfig) {
        this.#config = config;
        this.#auth = config.auth;
        this.#oauth =
            config.auth?.provider === "oauth2" && config.publicBaseUrl !== undefined && config.storageDir !== undefined
                ? new McpOAuthProtectedResource(config.auth.oauth2, config.publicBaseUrl, config.storageDir)
                : undefined;

        for (const instance of config.instances) {
            this.registerInstance(instance);
        }

        this.#httpServer = new McpHostHttpServer({
            auth: config.auth,
            listenHost: config.listenHost,
            listenPort: config.listenPort,
            oauth: this.#oauth,
            publicBaseUrl: config.publicBaseUrl
        });
    }

    async start(): Promise<void> {
        this.#guard.assertSafe(this.#config);
        if (this.#auth?.provider === "oauth2" && this.#oauth === undefined) {
            throw new Error("mcp.publicBaseUrl and storageDir are required when mcp.auth.mode=oauth2");
        }
        await this.#oauth?.warmup();
        for (const binding of this.#registry.list()) {
            this.#httpServer.registerBinding(binding.path, binding.binding);
        }
        await this.#httpServer.start();
        this.#started = true;
    }

    async stop(): Promise<void> {
        await this.#httpServer.stop();
        await Promise.all(this.#registry.list().map(async (binding) => await binding.binding.close()));
        this.#started = false;
    }

    registerInstance(instance: McpHostInstanceConfig): void {
        const binding = new McpEndpointBinding(
            new McpEndpointWorker({
                allowlist: instance.allowlist,
                instanceName: instance.name,
                worker: instance.worker
            })
        );
        const path = instance.path ?? `/${instance.name}/mcp`;

        this.#registry.register({
            binding,
            path
        });

        if (this.#started) {
            this.#httpServer.registerBinding(path, binding);
        }
    }

    get server(): McpHostHttpServer {
        return this.#httpServer;
    }

    get oauthApprovals(): McpOAuthApprovalService | undefined {
        return this.#oauth?.approvals;
    }

    status(): {
        authMode: "none" | "oauth2" | "token";
        listenAddress?: string;
        oauthReady: boolean;
        publicBaseUrl?: string;
        running: boolean;
    } {
        const address = this.#httpServer.address;
        const running = this.#started && address !== undefined && address !== null;
        const listenAddress = typeof address === "object" && address !== null ? `${address.address}:${address.port}` : undefined;
        return {
            authMode: this.#auth?.provider ?? "none",
            ...(listenAddress === undefined ? {} : { listenAddress }),
            oauthReady: this.#auth?.provider !== "oauth2" || this.#oauth !== undefined,
            ...(this.#config.publicBaseUrl === undefined ? {} : { publicBaseUrl: this.#config.publicBaseUrl }),
            running
        };
    }
}
