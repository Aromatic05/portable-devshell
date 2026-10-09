import type { ContextTransport, ControlMcpContextMode } from "@portable-devshell/shared";
import type { McpHttpAccess, McpHttpListener } from "./Api.js";
import type { McpAuthConfig, McpOAuthApprovalConfig } from "../oauth/Config.js";
import type { McpOAuthProtectedResource } from "../oauth/Route.js";
import type { McpOAuthApprovalService } from "../oauth/interaction/Approval.js";
import { createMcpAppMcpExtension } from "../mcpapp/Extension.js";
import type { McpToolProvenanceRecorder } from "../protocol/tool/Provenance.js";
import type { McpToolSource } from "../protocol/tool/Source.js";
import type { McpRuntimeState } from "../Runtime.js";
import { McpProtocolRoute } from "../protocol/Route.js";
import { McpAppRoute } from "../mcpapp/Route.js";
import { McpAppCall } from "../mcpapp/Call.js";

export interface McpHostInstanceConfig {
    auth?: McpAuthConfig;
    contextMode?: ControlMcpContextMode;
    name: string;
    path?: string;
}

export interface McpHostConfig {
    instances: readonly McpHostInstanceConfig[];
    listenHost: string;
    listenPort: number;
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
    readonly #runtimeState: McpRuntimeState;
    #started = false;
    #disposed = false;
    #oauthUninstall?: () => void;

    constructor(config: McpHostConfig, state: McpRuntimeState, http: McpHttpAccess) {
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
        if (oauthConfig(this.#config.instances) !== undefined && this.#oauth === undefined)
            throw new Error(
                "mcp.publicBaseUrl and storageDir are required when an instance uses oauth2 auth",
            );
        await this.#runtimeState.initialize();
        await this.#oauth?.warmup();
        try {
            this.#protocol.start();
            if (this.#oauth !== undefined && oauthConfig(this.#config.instances) !== undefined)
                this.#oauthUninstall = this.#oauth.attach(this.#httpServer);
            const route = this.#runtimeState.app.attachHost(this.#httpServer, this.#contexts);
            for (const entry of this.#protocol.list()) route.register(entry.binding.instanceName);
            this.#appRoute = route;
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
        await this.#httpServer.stop();
    }

    async dispose(): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        try {
            await this.stop();
        } finally {
            await this.#httpServer.dispose?.();
        }
    }

    registerInstance(instance: McpHostInstanceConfig): void {
        const path = instance.path ?? `/${instance.name}/mcp`;
        this.#protocol.registerInstance(
            {
                auth: instance.auth,
                context: this.#contexts,
                contextMode: instance.contextMode ?? "explicit",
                extensions: [createMcpAppMcpExtension(this.#config.publicBaseUrl)],
                instanceName: instance.name,
                toolAdapter: (dispatch) =>
                    new McpAppCall({
                        actions: this.#runtimeState.app.actions,
                        context: this.#contexts,
                        dispatch,
                        instance: instance.name,
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
        this.#appRoute?.register(instance.name);
    }

    unregisterInstance(instanceName: string): void {
        this.#appRoute?.unregister(instanceName);
        this.#runtimeState.app.presence.revokeInstance(instanceName);
        this.#protocol.unregister(instanceName);
    }

    revokeMcpAppContext(ctxId: string): void {
        this.#appRoute?.revokeContext(ctxId);
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
