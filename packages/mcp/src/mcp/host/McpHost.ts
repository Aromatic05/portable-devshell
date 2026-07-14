import type { JsonValue, ToolDefinition, ToolPolicy } from "@portable-devshell/shared";
import { type McpAuthConfig } from "../auth/McpAuthConfig.js";
import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
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
    callTool(
        toolName: string,
        input: JsonValue,
        context: { requestId?: string; sessionId?: string; source: "mcp" },
        signal?: AbortSignal
    ): Promise<JsonValue>;
    hasToolSchemaCache?(): boolean;
    listTools(): ToolDefinition[];
    snapshot(): { ready?: boolean };
}

export interface McpHostInstanceConfig {
    gateway?: McpInstanceGateway;
    policy: ToolPolicy;
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
    readonly #retiredBindingClosures = new Set<Promise<void>>();
    #started = false;

    constructor(config: McpHostConfig) {
        this.#config = config;
        this.#auth = config.auth;
        this.#oauth =
            config.auth?.provider === "oauth2" && config.publicBaseUrl !== undefined && config.storageDir !== undefined
                ? new McpOAuthProtectedResource(config.auth.oauth2, config.publicBaseUrl, config.storageDir, {
                      trustProxy: isLoopbackHost(config.listenHost)
                  })
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
        await Promise.all([
            ...this.#registry.list().map(async (binding) => await binding.binding.close()),
            ...this.#retiredBindingClosures
        ]);
        this.#started = false;
    }

    registerInstance(instance: McpHostInstanceConfig): void {
        const binding = new McpEndpointBinding(
            new McpEndpointWorker({
                gateway: instance.gateway,
                policy: instance.policy,
                instanceName: instance.name,
                worker: instance.worker
            })
        );
        const path = instance.path ?? `/${instance.name}/mcp`;

        const previous = this.#registry.register({
            binding,
            path
        });

        if (this.#started) {
            if (previous !== undefined && previous.path !== path) {
                this.#httpServer.unregisterBinding(previous.path);
            }
            this.#httpServer.registerBinding(path, binding);
        }
        if (previous !== undefined) {
            this.#retireBinding(previous.binding);
        }
    }

    unregisterInstance(instanceName: string): void {
        const previous = this.#registry.unregister(instanceName);
        if (previous === undefined) {
            return;
        }
        if (this.#started) {
            this.#httpServer.unregisterBinding(previous.path);
        }
        this.#retireBinding(previous.binding);
    }

    #retireBinding(binding: McpEndpointBinding): void {
        const closure = binding.close().finally(() => {
            this.#retiredBindingClosures.delete(closure);
        });
        this.#retiredBindingClosures.add(closure);
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
        protocolReadiness: "notChecked";
        publicBaseUrl?: string;
        publicReachability: "notChecked";
        running: boolean;
    } {
        const address = this.#httpServer.address;
        const running = this.#started && address !== undefined && address !== null;
        const listenAddress = typeof address === "object" && address !== null ? `${address.address}:${address.port}` : undefined;
        return {
            authMode: this.#auth?.provider ?? "none",
            ...(listenAddress === undefined ? {} : { listenAddress }),
            oauthReady: this.#auth?.provider !== "oauth2" || this.#oauth !== undefined,
            protocolReadiness: "notChecked",
            ...(this.#config.publicBaseUrl === undefined ? {} : { publicBaseUrl: this.#config.publicBaseUrl }),
            publicReachability: "notChecked",
            running
        };
    }
}

function isLoopbackHost(host: string): boolean {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
