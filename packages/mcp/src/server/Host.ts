import type { ContextTransport, ControlMcpContextMode } from "@portable-devshell/shared";
import type { McpHttpAccess, McpHttpListener } from "./Api.js";
import type { McpAuthConfig, McpOAuthApprovalConfig } from "../oauth/Config.js";
import type { McpOAuthProtectedResource } from "../oauth/Route.js";
import type { McpOAuthApprovalService } from "../oauth/interaction/Approval.js";
import { createMcpAppMcpExtension } from "../mcpapp/Extension.js";
import type { McpToolProvenanceRecorder } from "../protocol/tool/Provenance.js";
import type { McpToolSource } from "../protocol/tool/Source.js";
import type { McpServer } from "./index.js";
import { McpProtocolRoute } from "../protocol/Route.js";
import { McpAppRoute } from "../mcpapp/Route.js";
import { McpAppCall } from "../mcpapp/Call.js";
import type { McpModelOutputBudget } from "../protocol/call/ModelOutput.js";

export interface McpHostInstanceConfig {
    auth?: McpAuthConfig;
    contextMode?: ControlMcpContextMode;
    inlineToolCalls?: boolean;
    name: string;
    modelOutput?: McpModelOutputBudget;
    path?: string;
}

export interface McpHostConfig {
    instances: readonly McpHostInstanceConfig[];
    listenHost: string;
    listenPort: number;
    modelOutput?: McpModelOutputBudget;
    oauthApproval?: McpOAuthApprovalConfig;
    publicBaseUrl?: string;
    serverVersion?: string;
    storageDir?: string;
    toolProvenance?: McpToolProvenanceRecorder;
    toolSource: McpToolSource;
    mcpAppLeaseFile?: string;
}

export class McpHost {
    readonly #config: McpHostConfig;
    readonly #contexts: Pick<ContextTransport, "resolve" | "validateForInstance">;
    readonly #httpServer: McpHttpListener;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #protocol: McpProtocolRoute;
    #appRoute?: McpAppRoute;
    readonly #runtimeState: McpServer;
    #started = false;
    #appReady = false;
    #disposed = false;
    #oauthUninstall?: () => void;

    constructor(config: McpHostConfig, state: McpServer, http: McpHttpAccess) {
        this.#config = config;
        this.#runtimeState = state;
        this.#contexts = state.context;
        const configuredOAuth = oauthConfig(config.instances);
        this.#oauth =
            config.publicBaseUrl !== undefined && config.storageDir !== undefined
                ? this.#runtimeState.oauthResource(
                      configuredOAuth ?? defaultOAuthConfig(),
                      config.publicBaseUrl,
                      config.storageDir,
                      config.oauthApproval ?? { mode: "tui" },
                      isLoopbackHost(config.listenHost),
                  )
                : undefined;

        this.#httpServer = http.acquire({ listenHost: config.listenHost, listenPort: config.listenPort });
        this.#protocol = new McpProtocolRoute(this.#httpServer, {
            ...(this.#oauth === undefined ? {} : { oauth: this.#oauth }),
            ...(config.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.publicBaseUrl }),
        });

        for (const instance of config.instances) {
            this.registerInstance(instance);
        }
    }

    /** Mounts MCP protocol and App routes without binding an HTTP listener. */
    async prepare(): Promise<void> {
        if (this.#disposed) throw new Error("MCP Host has been disposed.");
        if (this.#started) return;
        if (this.#requiresOAuth() && this.#oauth === undefined)
            throw new Error(
                "mcp.publicBaseUrl and storageDir are required when an instance uses oauth2 auth",
            );
        const appReady = await this.#runtimeState.initialize().then(
            () => true,
            (error: unknown) => {
                console.warn("MCP App unavailable; mounting core MCP routes only:", error);
                return false;
            },
        );
        await this.#oauth?.warmup();
        try {
            this.#protocol.start();
            if (this.#oauth !== undefined && this.#requiresOAuth())
                this.#oauthUninstall = this.#oauth.attach(this.#httpServer);
            if (appReady) {
                try {
                    const route = this.#runtimeState.app.attachHost(this.#httpServer, this.#contexts, this.#config.publicBaseUrl);
                    for (const entry of this.#protocol.list()) route.register(entry.binding.instanceName);
                    this.#appRoute = route;
                    this.#appReady = true;
                } catch (error) {
                    this.#runtimeState.app.detachHost(this.#httpServer);
                    console.warn("MCP App routes unavailable; core MCP will continue:", error);
                }
            }
            this.#started = true;
        } catch (error) {
            this.retire();
            throw error;
        }
    }

    /** Unmounts routes; the transport owner closes the underlying listener. */
    retire(): void {
        this.#protocol.stop();
        this.#runtimeState.app.detachHost(this.#httpServer);
        this.#oauthUninstall?.();
        this.#oauthUninstall = undefined;
        this.#appRoute = undefined;
        this.#appReady = false;
        this.#started = false;
    }

    // Standalone MCP consumers retain the combined start/stop convenience.
    async start(): Promise<void> {
        await this.prepare();
        try {
            await this.#httpServer.start();
        } catch (error) {
            this.retire();
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.retire();
        await this.drain({ timeoutMs: 5_000, force: true });
        await this.#httpServer.stop();
    }

    /** Explicit final-shutdown barrier; not used when hot-replacing a Host. */
    async drain(options: { timeoutMs?: number; force?: boolean } = {}): Promise<void> {
        await this.#protocol.drain(options);
    }

    async dispose(): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        try {
            // Disposal after hot replacement releases the HTTP lease but leaves
            // previously admitted requests running on their captured Binding.
            this.retire();
            await this.#httpServer.stop();
        } finally {
            await this.#httpServer.dispose?.();
        }
    }

    registerInstance(instance: McpHostInstanceConfig): void {
        if (this.#disposed) throw new Error("MCP Host has been disposed.");
        const wantsOAuth = instance.auth?.provider === "oauth2";
        // Initial declarations are validated by prepare() before HTTP mounts;
        // live additions must fail before mutating a running Host.
        if (this.#started && wantsOAuth && this.#oauth === undefined)
            throw new Error("mcp.publicBaseUrl and storageDir are required when an instance uses oauth2 auth");
        const mountOAuth = this.#started && wantsOAuth && this.#oauthUninstall === undefined;
        if (mountOAuth) this.#oauthUninstall = this.#oauth!.attach(this.#httpServer);
        const mountApp = this.#appRoute !== undefined && !this.#appRoute.has(instance.name);
        const path = instance.path ?? `/${instance.name}/mcp`;
        const mcpAppExtension = createMcpAppMcpExtension(this.#config.publicBaseUrl, {
            inlineToolCalls: instance.inlineToolCalls === true,
        });
        try {
            if (mountApp) this.#appRoute?.register(instance.name);
            this.#protocol.registerInstance(
                {
                    auth: instance.auth,
                    context: this.#contexts,
                    contextMode: instance.contextMode ?? "explicit",
                    extensions: [mcpAppExtension],
                    instanceName: instance.name,
                    instanceRoutingEnabled: true,
                    modelOutput: instance.modelOutput ?? this.#config.modelOutput,
                    toolAdapter: (dispatch) =>
                        new McpAppCall({
                            actions: this.#runtimeState.app.actions,
                            context: this.#contexts,
                            dispatch,
                            instance: instance.name,
                            ownsPresentation: (toolName) => {
                                if (!this.#appReady) return false;
                                const definition = this.#config.toolSource.get(instance.name, toolName)?.definition;
                                const meta = definition?._meta;
                                if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return true;
                                const ui = meta.ui;
                                // The Catalog respects extensions' own MCP App
                                // resources; those apps must not receive the
                                // DevShell Context's private Live capability.
                                return typeof meta["openai/outputTemplate"] !== "string" &&
                                    !(typeof ui === "object" && ui !== null && !Array.isArray(ui) &&
                                        typeof ui.resourceUri === "string");
                            },
                            toolCallResourceUriForTool: mcpAppExtension.presentation!.toolCallResourceUriForTool,
                            ...(this.#runtimeState.app.view === undefined
                                ? {}
                                : { view: this.#runtimeState.app.view }),
                            bootstrap: (result, request) =>
                                this.#runtimeState.app.bootstrap({
                                    context: this.#contexts,
                                    contextMode: instance.contextMode,
                                    instance: instance.name,
                                    publicBaseUrl: this.#config.publicBaseUrl,
                                    request,
                                    result,
                                }),
                        }),
                    toolProvenance: this.#config.toolProvenance,
                    toolSource: this.#config.toolSource,
                    tools: this.#runtimeState.tools,
                },
                path,
                this.#config.serverVersion,
            );
        } catch (error) {
            if (mountApp) this.#appRoute?.unregister(instance.name);
            if (mountOAuth) {
                this.#oauthUninstall?.();
                this.#oauthUninstall = undefined;
            }
            throw error;
        }
        this.#syncOAuthRoutes();
    }

    unregisterInstance(instanceName: string): void {
        this.#protocol.unregister(instanceName);
        this.#appRoute?.unregister(instanceName);
        this.#runtimeState.app.presence.revokeInstance(instanceName);
        this.#syncOAuthRoutes();
    }

    #requiresOAuth(): boolean {
        return this.#protocol.list().some((entry) => entry.auth?.provider === "oauth2");
    }

    #syncOAuthRoutes(): void {
        if (!this.#started || this.#requiresOAuth() || this.#oauthUninstall === undefined) return;
        this.#oauthUninstall();
        this.#oauthUninstall = undefined;
    }

    async retireMcpApp(instanceName: string): Promise<void> {
        this.#appRoute?.unregister(instanceName);
        await this.#runtimeState.app.revokeInstance(instanceName);
    }

    get server(): McpHttpListener {
        return this.#httpServer;
    }

    get oauthApprovals(): McpOAuthApprovalService | undefined {
        return this.#oauth?.approvals;
    }

    get oauthProtectedResource(): McpOAuthProtectedResource | undefined {
        return this.#oauth;
    }

    status(): {
        appReady: boolean;
        authMode: "none" | "oauth2" | "token";
        listenAddress?: string;
        oauthReady: boolean;
        publicBaseUrl?: string;
        reason?: string;
        running: boolean;
    } {
        const address = this.#httpServer.address;
        const running = this.#started && address !== undefined && address !== null;
        const listenAddress =
            typeof address === "object" && address !== null
                ? `${address.address}:${address.port}`
                : undefined;
        const registered = this.#protocol.list();
        const authProviders = registered
            .map((instance) => instance.auth?.provider)
            .filter(
                (provider): provider is "oauth2" | "token" => provider === "oauth2" || provider === "token",
            );
        const authMode = authProviders.includes("oauth2")
            ? "oauth2"
            : authProviders.includes("token")
              ? "token"
              : "none";
        return {
            appReady: this.#appReady,
            authMode,
            ...(listenAddress === undefined ? {} : { listenAddress }),
            oauthReady: !authProviders.includes("oauth2") || this.#oauth !== undefined,
            ...(this.#config.publicBaseUrl === undefined
                ? {}
                : { publicBaseUrl: this.#config.publicBaseUrl }),
            ...(running ? {} : { reason: "MCP host is not listening." }),
            running,
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
        resourceName: first!.resourceName,
    };
}

function defaultOAuthConfig() {
    return {
        requiredScopes: [],
        resourceName: "portable-devshell",
    };
}

function isLoopbackHost(host: string): boolean {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
