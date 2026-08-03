import type { JsonValue, ToolCallContext, ToolDefinition, ToolPolicy } from "@portable-devshell/shared";
import { type McpAuthConfig } from "../auth/McpAuthConfig.js";
import { McpContextRegistry } from "../context/McpContextRegistry.js";
import type { McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import { McpOAuthProtectedResource } from "../auth/oauth/McpOAuthProtectedResource.js";
import type { McpOAuthApprovalService } from "../auth/oauth/McpOAuthApprovalService.js";
import { McpEndpointBinding } from "../endpoint/McpEndpointBinding.js";
import { McpEndpointWorker } from "../endpoint/McpEndpointWorker.js";
import { HttpHost } from "./HttpHost.js";
import { McpHostRouteRegistry } from "./route/McpHostRouteRegistry.js";

interface WorkerInstanceLike {
    auditToolCall<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string) => Promise<T>,
        signal?: AbortSignal
    ): Promise<T>;
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(toolName: string, context: { ctxId?: string; requestId?: string }): Promise<void>;
    callTool(
        toolName: string,
        input: JsonValue,
        context: { ctxId?: string; requestId?: string; source: "mcp" },
        signal?: AbortSignal
    ): Promise<JsonValue>;
    hasToolSchemaCache?(): boolean;
    listTools(): ToolDefinition[];
    snapshot(): { ready?: boolean };
}

export interface McpHostInstanceConfig {
    auth?: McpAuthConfig;
    gateway?: McpInstanceGateway;
    policy: ToolPolicy;
    name: string;
    path?: string;
    worker: WorkerInstanceLike;
}

export interface McpHostConfig {
    contextFile?: string;
    instances: readonly McpHostInstanceConfig[];
    listenHost: string;
    listenPort: number;
    publicBaseUrl?: string;
    storageDir?: string;
}

export class McpHost {
    readonly #config: McpHostConfig;
    readonly #contextRegistry: McpContextRegistry;
    readonly #httpServer: HttpHost;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #registry = new McpHostRouteRegistry();
    readonly #retiredBindingClosures = new Set<Promise<void>>();
    #started = false;

    constructor(config: McpHostConfig) {
        this.#config = config;
        this.#contextRegistry = new McpContextRegistry({ filePath: config.contextFile });
        const configuredOAuth = oauthConfig(config.instances);
        this.#oauth =
            config.publicBaseUrl !== undefined && config.storageDir !== undefined
                ? new McpOAuthProtectedResource(
                      configuredOAuth ?? defaultOAuthConfig(),
                      new URL(config.publicBaseUrl).origin,
                      config.storageDir,
                      { trustProxy: isLoopbackHost(config.listenHost) }
                  )
                : undefined;

        for (const instance of config.instances) {
            this.registerInstance(instance);
        }

        this.#httpServer = new HttpHost({
            listenHost: config.listenHost,
            listenPort: config.listenPort,
            oauth: this.#oauth,
            publicBaseUrl: config.publicBaseUrl
        });
    }

    async start(): Promise<void> {
        if (oauthConfig(this.#config.instances) !== undefined && this.#oauth === undefined) {
            throw new Error("mcp.publicBaseUrl and storageDir are required when an instance uses oauth2 auth");
        }
        await this.#contextRegistry.initialize();
        await this.#oauth?.warmup();
        for (const binding of this.#registry.list()) {
            this.#httpServer.registerBinding(binding.path, binding.binding, binding.auth);
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
                contextRegistry: this.#contextRegistry,
                gateway: instance.gateway,
                policy: instance.policy,
                instanceName: instance.name,
                worker: instance.worker
            })
        );
        const path = instance.path ?? `/${instance.name}/mcp`;

        const previous = this.#registry.register({
            auth: instance.auth ?? { enabled: false, provider: "none" },
            binding,
            path
        });

        if (this.#started) {
            if (previous !== undefined && previous.path !== path) {
                this.#httpServer.unregisterBinding(previous.path);
            }
            this.#httpServer.registerBinding(path, binding, instance.auth);
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

    get server(): HttpHost {
        return this.#httpServer;
    }

    get oauthApprovals(): McpOAuthApprovalService | undefined {
        return this.#oauth?.approvals;
    }

    get oauthProtectedResource(): McpOAuthProtectedResource | undefined {
        return this.#oauth;
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
        const registered = this.#registry.list();
        const authProviders = registered
            .map((instance) => instance.auth?.provider)
            .filter((provider): provider is "oauth2" | "token" => provider === "oauth2" || provider === "token");
        const authMode = authProviders.includes("oauth2") ? "oauth2" : authProviders.includes("token") ? "token" : "none";
        return {
            authMode,
            ...(listenAddress === undefined ? {} : { listenAddress }),
            oauthReady: !authProviders.includes("oauth2") || this.#oauth !== undefined,
            protocolReadiness: "notChecked",
            ...(this.#config.publicBaseUrl === undefined ? {} : { publicBaseUrl: this.#config.publicBaseUrl }),
            publicReachability: "notChecked",
            running
        };
    }
}

function oauthConfig(instances: readonly McpHostInstanceConfig[]) {
    const oauth = instances
        .map((instance) => instance.auth)
        .filter((auth): auth is McpAuthConfig => auth !== undefined)
        .filter((auth) => auth.provider === "oauth2")
        .map((auth) => auth.oauth2);
    if (oauth.length === 0) return undefined;
    const [first] = oauth;
    return {
        documentationUrl: first!.documentationUrl,
        requiredScopes: [...new Set(oauth.flatMap((entry) => entry.requiredScopes))],
        resourceName: first!.resourceName
    };
}

function defaultOAuthConfig() {
    return {
        requiredScopes: [],
        resourceName: "portable-devshell"
    };
}

function isLoopbackHost(host: string): boolean {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
