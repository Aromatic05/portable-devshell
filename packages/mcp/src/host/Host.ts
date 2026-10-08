import type {
    ContextTransport,
    ControlMcpContextMode,
    Endpoint,
    ToolCallApi,
} from "@portable-devshell/shared";
import type {
    McpAuthConfig,
    McpOAuth2Config,
    McpOAuthApprovalConfig,
} from "../auth/Config.js";
import { McpOAuthProtectedResource } from "../auth/oauth/Resource.js";
import { McpOAuthApprovalService } from "../auth/oauth/interaction/Approval.js";
import { McpEndpointBinding } from "../endpoint/Binding.js";
import { McpEndpoint } from "../endpoint/Endpoint.js";
import { createMcpContextSelector } from "../context/Selector.js";
import { createMcpAppMcpExtension } from "../endpoint/extension/McpApp.js";
import { McpExtensionRegistry } from "../endpoint/extension/Registry.js";
import type { McpToolProvenanceRecorder } from "../endpoint/tool/Provenance.js";
import type { McpToolSource } from "../endpoint/tool/Source.js";
import { McpAppLeaseStore } from "../mcpapp/app/Lease.js";
import { installMcpAppLive } from "../mcpapp/app/Live.js";
import { mcpAppAssetDirectory } from "../mcpapp/app/App.js";
import { McpAppPresenceStore } from "../mcpapp/app/Presence.js";
import { McpAppActionStore } from "../mcpapp/ActionStore.js";
import { createMcpAppViewModel } from "../mcpapp/ViewModel.js";
import { HttpHost } from "./Http.js";
import { McpHostRouteRegistry } from "./Route.js";

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

export class McpRuntimeState {
    readonly tools: ToolCallApi;
    readonly context: ContextTransport;
    readonly oauthApprovals?: McpOAuthApprovalService;
    readonly #oauthResources = new Map<string, McpOAuthProtectedResource>();
    readonly mcpAppLeases: McpAppLeaseStore;
    readonly mcpAppView?: ReturnType<typeof createMcpAppViewModel>;
    readonly workspaceActions: McpAppActionStore;
    readonly mcpAppPresence = new McpAppPresenceStore();
    #initializePromise?: Promise<void>;

    constructor(config: {
        context: ContextTransport;
        endpoint?: Endpoint;
        tools: ToolCallApi;
        storageDir?: string;
        mcpAppLeaseFile?: string;
    }) {
        this.context = config.context;
        this.tools = config.tools;
        this.mcpAppLeases = new McpAppLeaseStore({
            filePath: config.mcpAppLeaseFile,
        });
        this.workspaceActions = new McpAppActionStore({
            filePath: config.mcpAppLeaseFile === undefined
                ? undefined
                : `${config.mcpAppLeaseFile}.actions`,
        });
        this.mcpAppView = config.endpoint === undefined
            ? undefined : createMcpAppViewModel(config.endpoint, this.workspaceActions);
        this.oauthApprovals =
            config.storageDir === undefined
                ? undefined
                : new McpOAuthApprovalService(config.storageDir);
    }

    async initialize(): Promise<void> {
        if (this.#initializePromise !== undefined) {
            return await this.#initializePromise;
        }
        const initialize = Promise.all([
            this.mcpAppLeases.initialize(),
            this.workspaceActions.initialize(),
        ]).then(() => undefined);
        this.#initializePromise = initialize;
        try {
            await initialize;
        } catch (error) {
            if (this.#initializePromise === initialize)
                this.#initializePromise = undefined;
            throw error;
        }
    }

    oauthResource(
        config: McpOAuth2Config,
        publicBaseUrl: string,
        storageDir: string,
        approval: McpOAuthApprovalConfig,
        trustProxy: boolean,
    ): McpOAuthProtectedResource {
        const origin = new URL(publicBaseUrl).origin;
        const key = JSON.stringify({
            documentationUrl: config.documentationUrl ?? null,
            approval,
            origin,
            requiredScopes: [...config.requiredScopes].sort(),
            resourceName: config.resourceName,
            storageDir,
            trustProxy,
        });
        let resource = this.#oauthResources.get(key);
        if (resource !== undefined) return resource;
        resource = new McpOAuthProtectedResource(config, origin, storageDir, {
            approval,
            ...(this.oauthApprovals === undefined
                ? {}
                : { approvals: this.oauthApprovals }),
            trustProxy,
        });
        this.#oauthResources.set(key, resource);
        return resource;
    }
}

export class McpHost {
    readonly #config: McpHostConfig;
    readonly #contexts: ContextTransport;
    readonly #httpServer: HttpHost;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #registry = new McpHostRouteRegistry();
    readonly #liveRouteCleanups = new Map<string, () => void>();
    readonly #runtimeState: McpRuntimeState;
    readonly #mcpAppLeases: McpAppLeaseStore;
    readonly #workspaceActions: McpAppActionStore;
    readonly #mcpAppPresence: McpAppPresenceStore;
    #started = false;

    constructor(config: McpHostConfig, state: McpRuntimeState) {
        this.#config = config;
        this.#runtimeState = state;
        this.#contexts = state.context;
        this.#mcpAppLeases = this.#runtimeState.mcpAppLeases;
        this.#workspaceActions = this.#runtimeState.workspaceActions;
        this.#mcpAppPresence = this.#runtimeState.mcpAppPresence;
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
        this.#httpServer.registerStaticDirectory("/mcpapp/assets", mcpAppAssetDirectory);

        for (const instance of config.instances) {
            this.registerInstance(instance);
        }
    }

    async start(): Promise<void> {
        if (
            oauthConfig(this.#config.instances) !== undefined &&
            this.#oauth === undefined
        ) {
            throw new Error(
                "mcp.publicBaseUrl and storageDir are required when an instance uses oauth2 auth",
            );
        }
        await this.#runtimeState.initialize();
        await this.#oauth?.warmup();
        for (const binding of this.#registry.list()) {
            if (!this.#liveRouteCleanups.has(binding.binding.instanceName))
                this.#attachLive(binding.binding.instanceName);
            this.#httpServer.registerBinding(
                binding.path,
                binding.binding,
                binding.auth,
            );
        }
        await this.#httpServer.start();
        this.#started = true;
    }

    async stop(): Promise<void> {
        for (const cleanup of this.#liveRouteCleanups.values()) cleanup();
        this.#liveRouteCleanups.clear();
        await this.#httpServer.stop();
        this.#started = false;
    }

    #attachLive(instance: string): void {
        const view = this.#runtimeState.mcpAppView;
        if (view !== undefined) {
            this.#liveRouteCleanups.set(instance, installMcpAppLive({
                contexts: this.#contexts,
                host: this.#httpServer,
                instance,
                leases: this.#mcpAppLeases,
                presence: this.#mcpAppPresence,
                view,
            }));
        }
    }

    registerInstance(instance: McpHostInstanceConfig): void {
        this.#liveRouteCleanups.get(instance.name)?.();
        this.#liveRouteCleanups.delete(instance.name);
        this.#attachLive(instance.name);
        const binding = new McpEndpointBinding(
            new McpEndpoint({
                auth: instance.auth,
                context: this.#contexts,
                contextMode: instance.contextMode ?? "explicit",
                extensions: new McpExtensionRegistry([
                    createMcpAppMcpExtension(this.#config.publicBaseUrl),
                ]),
                instanceName: instance.name,
                mcpAppActions: this.#workspaceActions,
                mcpAppView: this.#runtimeState.mcpAppView,
                mcpAppBootstrap: async (result, request) => {
                    const structured = typeof result === "object" && result !== null && !Array.isArray(result)
                        ? result : {};
                    const ctxId = typeof structured.ctxId === "string" ? structured.ctxId : undefined;
                    const selector = createMcpContextSelector(instance.contextMode ?? "explicit");
                    const externalBindings = selector.bindings(request);
                    if (ctxId === undefined && externalBindings.length === 0) return undefined;
                    const record = await this.#contexts.resolve({
                        ...(ctxId === undefined ? { externalBindings } : { ctxId }),
                        instance: instance.name,
                        principal: request.principal,
                        touch: false,
                    });
                    if (record.status !== "active" || !record.environments.some((item) => item.instance === instance.name))
                        return undefined;
                    const token = await this.#mcpAppLeases.issue(instance.name, record.ctxId);
                    this.#mcpAppPresence.open(instance.name, record.ctxId);
                    const base = this.#config.publicBaseUrl;
                    const liveBaseUrl = base === undefined ? undefined
                        : `${base.replace(/\/+$/u, "")}/api/live/${encodeURIComponent(instance.name)}/workspace`;
                    return {
                        ctxId: record.ctxId,
                        token,
                        ...(liveBaseUrl === undefined ? {} : { liveBaseUrl }),
                    };
                },
                toolProvenance: this.#config.toolProvenance,
                toolSource: this.#config.toolSource,
                tools: this.#runtimeState.tools,
            }),
            this.#config.serverVersion,
        );
        const path = instance.path ?? `/${instance.name}/mcp`;

        const previous = this.#registry.register({
            auth: instance.auth ?? { enabled: false, provider: "none" },
            binding,
            path,
        });
        if (this.#started) {
            if (previous !== undefined && previous.path !== path) {
                this.#httpServer.unregisterBinding(previous.path);
            }
            this.#httpServer.registerBinding(path, binding, instance.auth);
        }
    }

    unregisterInstance(instanceName: string): void {
        this.#liveRouteCleanups.get(instanceName)?.();
        this.#liveRouteCleanups.delete(instanceName);
        this.#mcpAppPresence.revokeInstance(instanceName);
        const previous = this.#registry.unregister(instanceName);
        if (previous === undefined) {
            return;
        }
        if (this.#started) {
            this.#httpServer.unregisterBinding(previous.path);
        }
    }

    async retireMcpApp(instanceName: string): Promise<void> {
        if (this.#started) {
            const route = this.#registry
                .list()
                .find((entry) => entry.binding.instanceName === instanceName);
            if (route !== undefined)
                this.#httpServer.unregisterBinding(route.path);
        }
        this.#liveRouteCleanups.get(instanceName)?.();
        this.#liveRouteCleanups.delete(instanceName);
        this.#mcpAppPresence.revokeInstance(instanceName);
        await this.#mcpAppLeases.revokeInstance(instanceName);
        await this.#workspaceActions.revokeInstance(instanceName);
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
        const registered = this.#registry.list();
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
