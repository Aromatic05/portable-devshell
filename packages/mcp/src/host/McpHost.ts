import type { ControlMcpContextMode, JsonValue, McpContextRecord, ToolCallContext, ToolDefinition, ToolPolicy } from "@portable-devshell/shared";
import { type McpAuthConfig } from "../auth/McpAuthConfig.js";
import { McpContextRegistry } from "../context/McpContextRegistry.js";
import { isMcpGoalGateway, type McpInstanceGateway } from "../instance/McpInstanceGateway.js";
import { McpOAuthProtectedResource } from "../auth/oauth/McpOAuthProtectedResource.js";
import type { McpOAuthApprovalService } from "../auth/oauth/McpOAuthApprovalService.js";
import { McpEndpointBinding } from "../endpoint/McpEndpointBinding.js";
import { McpEndpointWorker } from "../endpoint/McpEndpointWorker.js";
import { installMcpWorkspaceLiveRoute, workspaceLiveBaseUrl } from "../workspace/McpWorkspaceLiveRoute.js";
import { WorkspaceAppLeaseStore } from "../workspace/WorkspaceAppLeaseStore.js";
import { WorkspaceAppPresenceStore } from "../workspace/WorkspaceAppPresenceStore.js";
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
    prepareWorkspace?(workspace: string): Promise<{
        projectMemoryAgentFile: string;
        projectMemoryDirectory: string;
        projectMemoryPresent?: boolean;
        temporaryDirectory: string;
        workspace: string;
    }>;
    readAlerts(workspace: string): Promise<{ advice: Array<{ code: string; text: string }> }>;
    releaseAlerts?(workspace: string): Promise<void>;
    touchAlerts?(workspace: string): Promise<void>;
    touchTemporaryDirectory?(path: string): Promise<void>;
    snapshot(): { ready?: boolean };
}

export interface McpHostInstanceConfig {
    auth?: McpAuthConfig;
    contextMode?: ControlMcpContextMode;
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
    serverVersion?: string;
    storageDir?: string;
    workspaceAppLeaseFile?: string;
}

export class McpHost {
    readonly #config: McpHostConfig;
    readonly #contextRegistry: McpContextRegistry;
    readonly #httpServer: HttpHost;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #registry = new McpHostRouteRegistry();
    readonly #gateways = new Map<string, McpInstanceGateway | undefined>();
    readonly #liveRouteCleanups = new Map<string, () => void>();
    readonly #workers = new Map<string, WorkerInstanceLike>();
    readonly #workspaceAppLeases: WorkspaceAppLeaseStore;
    readonly #workspaceAppPresence = new WorkspaceAppPresenceStore();
    #started = false;

    constructor(config: McpHostConfig) {
        this.#config = config;
        this.#contextRegistry = new McpContextRegistry({ filePath: config.contextFile });
        this.#workspaceAppLeases = new WorkspaceAppLeaseStore({ filePath: config.workspaceAppLeaseFile });
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

        this.#httpServer = new HttpHost({
            listenHost: config.listenHost,
            listenPort: config.listenPort,
            oauth: this.#oauth,
            publicBaseUrl: config.publicBaseUrl
        });

        for (const instance of config.instances) {
            this.registerInstance(instance);
        }
    }

    async start(): Promise<void> {
        if (oauthConfig(this.#config.instances) !== undefined && this.#oauth === undefined) {
            throw new Error("mcp.publicBaseUrl and storageDir are required when an instance uses oauth2 auth");
        }
        await this.#contextRegistry.initialize();
        await this.#workspaceAppLeases.initialize();
        for (const instance of this.#config.instances) {
            if (!workspaceAppEnabled(instance.policy)) {
                await this.retireWorkspaceApp(instance.name);
            }
        }
        await this.#oauth?.warmup();
        for (const binding of this.#registry.list()) {
            this.#httpServer.registerBinding(binding.path, binding.binding, binding.auth);
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
        this.#gateways.set(instance.name, instance.gateway);
        this.#workers.set(instance.name, instance.worker);
        const workspaceApp = workspaceAppEnabled(instance.policy);
        if (!workspaceApp) this.#workspaceAppPresence.revokeInstance(instance.name);
        const liveBaseUrl = workspaceApp
            ? workspaceLiveBaseUrl(this.#config.publicBaseUrl, instance.name)
            : undefined;
        const binding = new McpEndpointBinding(
            new McpEndpointWorker({
                auth: instance.auth,
                contextRegistry: this.#contextRegistry,
                contextMode: instance.contextMode ?? "explicit",
                gateway: instance.gateway,
                policy: instance.policy,
                instanceName: instance.name,
                worker: instance.worker,
                ...(workspaceApp ? {
                    workspaceAppLeases: this.#workspaceAppLeases,
                    workspaceAppPresence: this.#workspaceAppPresence,
                } : {}),
                ...(liveBaseUrl === undefined ? {} : { workspaceLiveBaseUrl: liveBaseUrl })
            }),
            this.#config.serverVersion,
            this.#config.publicBaseUrl,
        );
        const path = instance.path ?? `/${instance.name}/mcp`;

        const previous = this.#registry.register({
            auth: instance.auth ?? { enabled: false, provider: "none" },
            binding,
            path
        });
        if (workspaceApp) {
            this.#liveRouteCleanups.set(instance.name, installMcpWorkspaceLiveRoute({
                contextRegistry: this.#contextRegistry,
                gateway: instance.gateway,
                host: this.#httpServer,
                instanceName: instance.name,
                leases: this.#workspaceAppLeases,
                presence: this.#workspaceAppPresence,
                publicBaseUrl: this.#config.publicBaseUrl,
                restoreTmuxWaits: async () => await binding.restoreTmuxWaits(),
            }));
        }

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
        this.#workspaceAppPresence.revokeInstance(instanceName);
        this.#gateways.delete(instanceName);
        this.#workers.delete(instanceName);
        const previous = this.#registry.unregister(instanceName);
        if (previous === undefined) {
            return;
        }
        if (this.#started) {
            this.#httpServer.unregisterBinding(previous.path);
        }
    }

    async retireWorkspaceApp(instanceName: string): Promise<void> {
        if (this.#started) {
            const route = this.#registry.list().find((entry) => entry.binding.instanceName === instanceName);
            if (route !== undefined) this.#httpServer.unregisterBinding(route.path);
        }
        this.#liveRouteCleanups.get(instanceName)?.();
        this.#liveRouteCleanups.delete(instanceName);
        this.#workspaceAppPresence.revokeInstance(instanceName);
        await this.#workspaceAppLeases.revokeInstance(instanceName);
        const gateway = this.#gateways.get(instanceName);
        if (gateway === undefined) return;
        while (true) {
            const claims = await this.#contextRegistry.listAutomaticReentryClaimsForInstance(instanceName);
            if (claims.length === 0) break;
            for (const claim of claims) {
                if (claim.sourceKind === "wait" && claim.sourceId !== undefined) {
                    if (gateway.disableWaitRecovery === undefined) {
                        throw new Error(`Cannot retire Workspace wait claim ${claim.claimId}.`);
                    }
                    const wait = gateway.listWaits === undefined
                        ? undefined
                        : (await gateway.listWaits(instanceName)).find((entry) => entry.waitId === claim.sourceId);
                    if (wait !== undefined && wait.status !== "consumed" && wait.status !== "cancelled") {
                        await gateway.disableWaitRecovery(instanceName, claim.sourceId);
                    }
                } else if (claim.sourceKind === "goal") {
                    if (gateway.goalContinuation === undefined) {
                        throw new Error(`Cannot retire Workspace Goal claim ${claim.claimId}.`);
                    }
                    await gateway.goalContinuation(
                        instanceName,
                        { action: "retire", ...(claim.sourceId === undefined ? {} : { goalId: claim.sourceId }) },
                        claim.ctxId,
                    );
                }
                await this.#contextRegistry.markAutomaticReentryRejected(
                    claim.ctxId,
                    instanceName,
                    claim.claimId,
                );
            }
        }
        if (gateway.readGoal !== undefined && gateway.goalContinuation !== undefined) {
            for (const context of await this.#contextRegistry.list()) {
                if (!context.environments.some((environment) => environment.instance === instanceName)) continue;
                const goal = await gateway.readGoal(instanceName, context.ctxId);
                if (goal?.continuationPending !== true && goal?.continuationUncertain !== true) continue;
                await gateway.goalContinuation(
                    instanceName,
                    { action: "retire", goalId: goal.goalId },
                    context.ctxId,
                );
            }
        }
        const waits = gateway.listWaits === undefined ? [] : await gateway.listWaits(instanceName);
        for (const wait of waits) {
            if (wait.status === "consumed" || wait.status === "cancelled") continue;
            if (
                wait.kind === "question" &&
                (wait.status === "waiting" || wait.status === "detached") &&
                gateway.cancelWait !== undefined
            ) {
                await gateway.cancelWait(instanceName, wait.waitId);
                continue;
            }
            if (gateway.disableWaitRecovery !== undefined) {
                await gateway.disableWaitRecovery(instanceName, wait.waitId);
            }
        }
    }

    get server(): HttpHost {
        return this.#httpServer;
    }

    get contextRegistry(): McpContextRegistry {
        return this.#contextRegistry;
    }

    get contextAdmin(): {
        detachInstance(instance: string): Promise<McpContextRecord[]>;
        disable(ctxId: string): Promise<McpContextRecord>;
        list(): Promise<McpContextRecord[]>;
        renew(ctxId: string): Promise<McpContextRecord>;
        validateForInstance(ctxId: string, instance: string): Promise<McpContextRecord>;
    } {
        return {
            detachInstance: async (instance) => {
                await this.#workspaceAppLeases.revokeInstance(instance);
                this.#workspaceAppPresence.revokeInstance(instance);
                return await this.#contextRegistry.detachInstance(instance);
            },
            disable: async (ctxId) => {
                const disabled = await this.#contextRegistry.disable(ctxId);
                await this.#workspaceAppLeases.revokeContext(ctxId);
                this.#workspaceAppPresence.revokeContext(ctxId);
                const contexts = await this.#contextRegistry.list();
                const now = Date.now();
                const reconciledInstances = new Set<string>();
                for (const environment of disabled.environments) {
                    const gateway = this.#gateways.get(environment.instance);
                    if (gateway !== undefined && !reconciledInstances.has(environment.instance)) {
                        reconciledInstances.add(environment.instance);
                        if (isMcpGoalGateway(gateway)) {
                            const goal = await gateway.readGoal(environment.instance, disabled.ctxId).catch(() => undefined);
                            if (goal?.status === "active" || goal?.status === "blocked") {
                                await gateway.manageGoal(environment.instance, { action: "stop" }, disabled.ctxId).catch(() => undefined);
                            }
                        }
                        if (gateway.listWaits !== undefined) {
                            const waits = await gateway.listWaits(environment.instance);
                            for (const wait of waits) {
                                if (wait.createdByCtxId !== disabled.ctxId) continue;
                                if ((wait.status === "waiting" || wait.status === "detached") && gateway.cancelWait !== undefined) {
                                    await gateway.cancelWait(environment.instance, wait.waitId);
                                } else if (wait.status === "resolved" && gateway.consumeWait !== undefined) {
                                    await gateway.consumeWait(environment.instance, wait.waitId);
                                }
                            }
                        }
                        if (gateway.failContextMessages !== undefined) {
                            await gateway.failContextMessages(
                                environment.instance,
                                disabled.ctxId,
                                `Context ${disabled.ctxId} was disabled before Comment delivery.`,
                            );
                        }
                        if (gateway.listApprovals !== undefined) {
                            const approvals = await gateway.listApprovals(environment.instance);
                            for (const approval of approvals) {
                                if (approval.ctxId !== disabled.ctxId || approval.status !== "pending") continue;
                                if (gateway.cancelApproval !== undefined) {
                                    await gateway.cancelApproval(
                                        environment.instance,
                                        approval.approvalId,
                                        `Context ${disabled.ctxId} was disabled.`,
                                    );
                                } else if (gateway.decideApproval !== undefined) {
                                    await gateway.decideApproval(environment.instance, approval.approvalId, "deny");
                                }
                            }
                        }
                    }
                    if (environment.workspace !== undefined) {
                        const hasOtherActiveContext = contexts.some((context) =>
                            context.ctxId !== disabled.ctxId &&
                            context.status === "active" &&
                            Date.parse(context.expiresAt) > now &&
                            context.environments.some((candidate) =>
                                candidate.instance === environment.instance &&
                                candidate.workspace === environment.workspace
                            )
                        );
                        if (!hasOtherActiveContext) {
                            const worker = this.#workers.get(environment.instance);
                            if (worker?.snapshot().ready === true) {
                                await worker.releaseAlerts?.(environment.workspace);
                            }
                        }
                    }
                    await gateway?.releaseInstanceReference?.(
                        environment.instance,
                        disabled.ctxId
                    );
                }
                return disabled;
            },
            list: async () => await this.#contextRegistry.list(),
            renew: async (ctxId) => {
                const renewed = await this.#contextRegistry.renew(ctxId);
                for (const environment of renewed.environments) {
                    if (environment.workspace === undefined) continue;
                    const worker = this.#workers.get(environment.instance);
                    if (worker?.snapshot().ready === true) {
                        await worker.touchAlerts?.(environment.workspace);
                    }
                }
                return renewed;
            },
            validateForInstance: async (ctxId, instance) =>
                await this.#contextRegistry.validateForInstance(ctxId, instance),
        };
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
            ...(this.#config.publicBaseUrl === undefined ? {} : { publicBaseUrl: this.#config.publicBaseUrl }),
            ...(running ? {} : { reason: "MCP host is not listening." }),
            running
        };
    }
}

function workspaceAppEnabled(policy: ToolPolicy): boolean {
    return policy.groups.includes("workspace");
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
