import type { ControlMcpContextMode } from "@portable-devshell/shared";
import type {
    McpAuthConfig,
    McpOAuth2Config,
    McpOAuthApprovalConfig,
} from "../auth/Config.js";
import type { ContextRegistryPort } from "@portable-devshell/shared";
import type { ContextRuntimePort } from "../context/Runtime.js";
import { McpOAuthProtectedResource } from "../auth/oauth/Resource.js";
import { McpOAuthApprovalService } from "../auth/oauth/interaction/Approval.js";
import { McpEndpointBinding } from "../endpoint/Binding.js";
import { McpEndpointWorker } from "../endpoint/Endpoint.js";
import type { McpToolProvenanceRecorder } from "../endpoint/tool/Provenance.js";
import { McpAppLeaseStore } from "../mcpapp/app/Lease.js";
import { McpAppPresenceStore } from "../mcpapp/app/Presence.js";
import { McpAppActionStore } from "../mcpapp/ActionStore.js";
import { HttpHost } from "./Http.js";
import { McpHostRouteRegistry } from "./Route.js";

export interface WorkerInstanceLike {
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(
        toolName: string,
        context: { ctxId?: string; requestId?: string },
    ): Promise<void>;
    prepareExtensionResource?(input: {
        collection: string;
        extensionId: string;
    }): Promise<{ directory: string }>;
    prepareWorkspace?(workspace: string): Promise<{
        projectMemoryAgentFile: string;
        projectMemoryDirectory: string;
        projectMemoryPresent?: boolean;
        temporaryDirectory: string;
        workspace: string;
    }>;
    readAlerts(
        workspace: string,
    ): Promise<{ advice: Array<{ code: string; text: string }> }>;
    releaseAlerts?(workspace: string): Promise<void>;
    touchAlerts?(workspace: string): Promise<
        | void
        | {
              advice: Array<{ code: string; text: string }>;
          }
    >;
    touchTemporaryDirectory?(path: string): Promise<void>;
    snapshot(): { ready?: boolean };
}

export interface McpHostInstanceConfig {
    auth?: McpAuthConfig;
    contextMode?: ControlMcpContextMode;
    name: string;
    path?: string;
    worker: WorkerInstanceLike;
    workspaceEnabled?: boolean;
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
    mcpAppLeaseFile?: string;
}

export class McpRuntimeState {
    readonly contexts: ContextRuntimePort;
    readonly oauthApprovals?: McpOAuthApprovalService;
    readonly #oauthResources = new Map<string, McpOAuthProtectedResource>();
    readonly workers = new Map<string, WorkerInstanceLike>();
    readonly mcpAppLeases: McpAppLeaseStore;
    readonly workspaceActions: McpAppActionStore;
    readonly mcpAppPresence = new McpAppPresenceStore();
    #initializePromise?: Promise<void>;

    constructor(config: {
        contexts: ContextRuntimePort;
        storageDir?: string;
        mcpAppLeaseFile?: string;
    }) {
        this.contexts = config.contexts;
        this.mcpAppLeases = new McpAppLeaseStore({
            filePath: config.mcpAppLeaseFile,
        });
        this.workspaceActions = new McpAppActionStore({
            filePath: config.mcpAppLeaseFile === undefined
                ? undefined
                : `${config.mcpAppLeaseFile}.actions`,
        });
        this.contexts.bindPresentation({
            revokeContext: async (ctxId) => {
                await this.mcpAppLeases.revokeContext(ctxId);
                await this.workspaceActions.revokeContext(ctxId);
                this.mcpAppPresence.revokeContext(ctxId);
            },
            revokeInstance: async (instance) => {
                await this.mcpAppLeases.revokeInstance(instance);
                await this.workspaceActions.revokeInstance(instance);
                this.mcpAppPresence.revokeInstance(instance);
            },
        });
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

    retainInstances(names: ReadonlySet<string>): void {
    }
}

export class McpHost {
    readonly #config: McpHostConfig;
    readonly #contextRegistry: ContextRegistryPort;
    readonly #httpServer: HttpHost;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #registry = new McpHostRouteRegistry();
    readonly #liveRouteCleanups = new Map<string, () => void>();
    readonly #runtimeState: McpRuntimeState;
    readonly #workers: Map<string, WorkerInstanceLike>;
    readonly #mcpAppLeases: McpAppLeaseStore;
    readonly #workspaceActions: McpAppActionStore;
    readonly #mcpAppPresence: McpAppPresenceStore;
    #started = false;

    constructor(config: McpHostConfig, state: McpRuntimeState) {
        this.#config = config;
        this.#runtimeState = state;
        this.#contextRegistry = state.contexts.registry;
        this.#workers = this.#runtimeState.workers;
        this.#mcpAppLeases = this.#runtimeState.mcpAppLeases;
        this.#workspaceActions = this.#runtimeState.workspaceActions;
        this.#mcpAppPresence = this.#runtimeState.mcpAppPresence;
        this.#runtimeState.retainInstances(
            new Set(config.instances.map((instance) => instance.name)),
        );
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
        await this.#httpServer.stop();
        this.#started = false;
    }

    registerInstance(instance: McpHostInstanceConfig): void {
        this.#liveRouteCleanups.get(instance.name)?.();
        this.#liveRouteCleanups.delete(instance.name);
        this.#workers.set(instance.name, instance.worker);
        const binding = new McpEndpointBinding(
            new McpEndpointWorker({
                auth: instance.auth,
                contextRegistry: this.#contextRegistry,
                contextMode: instance.contextMode ?? "explicit",
                instanceName: instance.name,
                toolProvenance: this.#config.toolProvenance,
                worker: instance.worker,
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
        this.#workers.delete(instanceName);
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
