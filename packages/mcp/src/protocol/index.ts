import type { ContextTransport, ControlMcpContextMode } from "@portable-devshell/shared";
import type { McpAuthConfig, McpOAuthApprovalConfig } from "../oauth/Config.js";
import { McpOAuthProtectedResource } from "../oauth/Route.js";
import type { McpOAuthApprovalService } from "../oauth/interaction/Approval.js";
import { McpEndpointBinding } from "../protocol/Binding.js";
import { McpEndpoint } from "../protocol/Endpoint.js";
import { createMcpAppMcpExtension } from "../mcpapp/Extension.js";
import { McpExtensionRegistry } from "../protocol/extension/Registry.js";
import type { McpToolProvenanceRecorder } from "../protocol/tool/Provenance.js";
import type { McpToolSource } from "../protocol/tool/Source.js";
import { McpRuntimeState } from "../Runtime.js";
import { HttpHost } from "../host/Http.js";
import { McpProtocolRoute } from "./Route.js";
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
    readonly #httpServer: HttpHost;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #protocol: McpProtocolRoute;
    readonly #appRoute: McpAppRoute;
    readonly #runtimeState: McpRuntimeState;
    #started = false;

    constructor(config: McpHostConfig, state: McpRuntimeState) {
        this.#config = config;
        this.#runtimeState = state;
        this.#contexts = state.context;
        const configuredOAuth = oauthConfig(config.instances);
        this.#oauth =
            config.publicBaseUrl !== undefined &&
            config.storageDir !== undefined
                ? this.#runtimeState.oauthResource(
                      configuredOAuth ?? defaultOAuthConfig(),
                      config.publicBaseUrl,
                      config.storageDir,
                      config.oauthApproval ?? { mode: "tui" },
                      isLoopbackHost(config.listenHost),
                  )
                : undefined;

        this.#httpServer = new HttpHost({
            listenHost: config.listenHost,
            listenPort: config.listenPort,
            oauth: this.#oauth,
            publicBaseUrl: config.publicBaseUrl,
        });
        this.#protocol = new McpProtocolRoute(this.#httpServer);
        this.#appRoute = new McpAppRoute(this.#httpServer, state.app, this.#contexts);

        for (const instance of config.instances) {
            this.registerInstance(instance);
        }
    }

    /** Mounts MCP protocol and App routes without binding an HTTP listener. */
    async prepare(): Promise<void> {
        if (this.#started) return;
        if (oauthConfig(this.#config.instances) !== undefined && this.#oauth === undefined)
            throw new Error('mcp.publicBaseUrl and storageDir are required when an instance uses oauth2 auth');
        await this.#runtimeState.initialize();
        await this.#oauth?.warmup();
        this.#protocol.start();
        for (const entry of this.#protocol.list()) this.#appRoute.register(entry.binding.instanceName);
        this.#started = true;
    }

    /** Unmounts routes; the transport owner closes the underlying listener. */
    retire(): void {
        this.#protocol.stop();
        this.#appRoute.stop();
        this.#started = false;
    }

    // Standalone MCP consumers retain the combined start/stop convenience.
    async start(): Promise<void> {
        await this.prepare();
        try { await this.#httpServer.start(); }
        catch (error) { this.retire(); throw error; }
    }

    async stop(): Promise<void> {
        this.retire();
        await this.#httpServer.stop();
    }

    registerInstance(instance: McpHostInstanceConfig): void {
        this.#appRoute.register(instance.name);
        const binding = new McpEndpointBinding(
            new McpEndpoint({
                auth: instance.auth,
                context: this.#contexts,
                contextMode: instance.contextMode ?? "explicit",
                extensions: new McpExtensionRegistry([
                    createMcpAppMcpExtension(this.#config.publicBaseUrl),
                ]),
                instanceName: instance.name,
                toolAdapter: (dispatch) => new McpAppCall({
                    actions: this.#runtimeState.app.actions,
                    context: this.#contexts,
                    dispatch,
                    instance: instance.name,
                    ...(this.#runtimeState.app.view === undefined ? {} : { view: this.#runtimeState.app.view }),
                    bootstrap: (result, request) => this.#runtimeState.app.bootstrap({
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
            }),
            this.#config.serverVersion,
        );
        const path = instance.path ?? `/${instance.name}/mcp`;

        this.#protocol.register({
            auth: instance.auth ?? { enabled: false, provider: 'none' },
            binding,
            path,
        });
    }

    unregisterInstance(instanceName: string): void {
        this.#appRoute.unregister(instanceName);
        this.#runtimeState.app.presence.revokeInstance(instanceName);
        this.#protocol.unregister(instanceName);
    }

    revokeMcpAppContext(ctxId: string): void {
        this.#appRoute.revokeContext(ctxId);
    }

    async retireMcpApp(instanceName: string): Promise<void> {
        this.#appRoute.unregister(instanceName);
        await this.#runtimeState.app.revokeInstance(instanceName);
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
        publicBaseUrl?: string;
        reason?: string;
        running: boolean;
    } {
        const address = this.#httpServer.address;
        const running =
            this.#started && address !== undefined && address !== null;
        const listenAddress =
            typeof address === "object" && address !== null
                ? `${address.address}:${address.port}`
                : undefined;
        const registered = this.#protocol.list();
        const authProviders = registered
            .map((instance) => instance.auth?.provider)
            .filter(
                (provider): provider is "oauth2" | "token" =>
                    provider === "oauth2" || provider === "token",
            );
        const authMode = authProviders.includes("oauth2")
            ? "oauth2"
            : authProviders.includes("token")
              ? "token"
              : "none";
        return {
            authMode,
            ...(listenAddress === undefined ? {} : { listenAddress }),
            oauthReady:
                !authProviders.includes("oauth2") || this.#oauth !== undefined,
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
        requiredScopes: [
            ...new Set(oauth.flatMap((entry) => entry.requiredScopes)),
        ],
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

export { McpRuntimeState } from "../Runtime.js";
