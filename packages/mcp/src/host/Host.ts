import type {
    ControlMcpContextMode,
    JsonValue,
    McpContextRecord,
    ToolCallContext,
    ToolDefinition,
} from "@portable-devshell/shared";
import type {
    McpAuthConfig,
    McpOAuth2Config,
    McpOAuthApprovalConfig,
} from "../auth/Config.js";
import { McpContextEnvironmentCleanupService } from "../context/Environment.js";
import { McpContextRegistry } from "../context/registry/Registry.js";
import {
    isMcpGoalGateway,
    isMcpInteractionGateway,
    type McpInstanceGateway,
} from "../endpoint/Port.js";
import { McpOAuthProtectedResource } from "../auth/oauth/Resource.js";
import { McpOAuthApprovalService } from "../auth/oauth/interaction/Approval.js";
import { McpEndpointBinding } from "../endpoint/Binding.js";
import { McpEndpointWorker } from "../endpoint/Endpoint.js";
import type { McpToolProvenanceRecorder } from "../endpoint/domain/worker/Provenance.js";
import {
    installMcpWorkspaceLiveRoute,
    workspaceLiveBaseUrl,
} from "../workspace/Route.js";
import { WorkspaceAppLeaseStore } from "../workspace/app/Lease.js";
import { WorkspaceAppPresenceStore } from "../workspace/app/Presence.js";
import { HttpHost } from "./Http.js";
import { McpHostRouteRegistry } from "./Route.js";

interface WorkerInstanceLike {
    callToolOperation<T extends JsonValue>(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        operation: (callId: string, input: JsonValue) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T>;
    appendMcpSessionClosed(sessionId: string): Promise<void>;
    appendMcpSessionOpened(sessionId: string): Promise<void>;
    appendMcpToolCalled(
        toolName: string,
        context: { ctxId?: string; requestId?: string },
    ): Promise<void>;
    callTool(
        toolName: string,
        input: JsonValue,
        context: { ctxId?: string; requestId?: string; source: "mcp" },
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    hasToolSchemaCache?(): boolean;
    listTools(): ToolDefinition[];
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
    touchAlerts?(workspace: string): Promise<void>;
    touchTemporaryDirectory?(path: string): Promise<void>;
    snapshot(): { ready?: boolean };
}

export interface McpHostInstanceConfig {
    auth?: McpAuthConfig;
    contextMode?: ControlMcpContextMode;
    gateway?: McpInstanceGateway;
    name: string;
    path?: string;
    worker: WorkerInstanceLike;
    workspaceEnabled?: boolean;
}

export interface McpHostConfig {
    contextFile?: string;
    instances: readonly McpHostInstanceConfig[];
    listenHost: string;
    listenPort: number;
    oauthApproval?: McpOAuthApprovalConfig;
    publicBaseUrl?: string;
    serverVersion?: string;
    storageDir?: string;
    toolProvenance?: McpToolProvenanceRecorder;
    workspaceAppLeaseFile?: string;
}

export class McpRuntimeState {
    readonly contextRegistry: McpContextRegistry;
    readonly environmentCleanup: McpContextEnvironmentCleanupService;
    readonly gateways = new Map<string, McpInstanceGateway | undefined>();
    readonly oauthApprovals?: McpOAuthApprovalService;
    readonly #oauthResources = new Map<string, McpOAuthProtectedResource>();
    readonly workers = new Map<string, WorkerInstanceLike>();
    readonly workspaceAppLeases: WorkspaceAppLeaseStore;
    readonly workspaceAppPresence = new WorkspaceAppPresenceStore();
    #initializePromise?: Promise<void>;

    constructor(config: {
        contextFile?: string;
        storageDir?: string;
        workspaceAppLeaseFile?: string;
    }) {
        this.contextRegistry = new McpContextRegistry({
            filePath: config.contextFile,
        });
        this.environmentCleanup = new McpContextEnvironmentCleanupService({
            contextRegistry: this.contextRegistry,
            gateway: (instance) => this.gateways.get(instance),
            releaseLocalAlerts: async (instance, workspace) => {
                const worker = this.workers.get(instance);
                if (worker === undefined) {
                    throw new Error(
                        `Instance ${instance} is unavailable for local alert cleanup.`,
                    );
                }
                await worker.releaseAlerts?.(workspace);
            },
        });
        this.workspaceAppLeases = new WorkspaceAppLeaseStore({
            filePath: config.workspaceAppLeaseFile,
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
            this.contextRegistry.initialize(),
            this.workspaceAppLeases.initialize(),
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
        for (const name of this.gateways.keys()) {
            if (names.has(name)) continue;
            this.gateways.delete(name);
            this.workers.delete(name);
            this.workspaceAppPresence.revokeInstance(name);
        }
    }
}

export class McpHost {
    readonly #config: McpHostConfig;
    readonly #contextRegistry: McpContextRegistry;
    readonly #httpServer: HttpHost;
    readonly #oauth?: McpOAuthProtectedResource;
    readonly #registry = new McpHostRouteRegistry();
    readonly #gateways: Map<string, McpInstanceGateway | undefined>;
    readonly #liveRouteCleanups = new Map<string, () => void>();
    readonly #runtimeState: McpRuntimeState;
    readonly #workers: Map<string, WorkerInstanceLike>;
    readonly #workspaceAppLeases: WorkspaceAppLeaseStore;
    readonly #workspaceAppPresence: WorkspaceAppPresenceStore;
    #started = false;

    constructor(config: McpHostConfig, state?: McpRuntimeState) {
        this.#config = config;
        this.#runtimeState =
            state ??
            new McpRuntimeState({
                ...(config.contextFile === undefined
                    ? {}
                    : { contextFile: config.contextFile }),
                ...(config.storageDir === undefined
                    ? {}
                    : { storageDir: config.storageDir }),
                ...(config.workspaceAppLeaseFile === undefined
                    ? {}
                    : {
                          workspaceAppLeaseFile:
                              config.workspaceAppLeaseFile,
                      }),
            });
        this.#contextRegistry = this.#runtimeState.contextRegistry;
        this.#gateways = this.#runtimeState.gateways;
        this.#workers = this.#runtimeState.workers;
        this.#workspaceAppLeases = this.#runtimeState.workspaceAppLeases;
        this.#workspaceAppPresence = this.#runtimeState.workspaceAppPresence;
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
        await this.#reconcileContextCleanup();
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
        this.#gateways.set(instance.name, instance.gateway);
        this.#workers.set(instance.name, instance.worker);
        const workspaceApp =
            instance.workspaceEnabled !== false &&
            isMcpInteractionGateway(instance.gateway);
        if (!workspaceApp)
            this.#workspaceAppPresence.revokeInstance(instance.name);
        const liveBaseUrl = workspaceApp
            ? workspaceLiveBaseUrl(this.#config.publicBaseUrl, instance.name)
            : undefined;
        const binding = new McpEndpointBinding(
            new McpEndpointWorker({
                auth: instance.auth,
                cleanup: this.#runtimeState.environmentCleanup,
                contextRegistry: this.#contextRegistry,
                contextMode: instance.contextMode ?? "explicit",
                gateway: instance.gateway,
                instanceName: instance.name,
                toolProvenance: this.#config.toolProvenance,
                worker: instance.worker,
                workspaceAppEnabled: workspaceApp,
                ...(workspaceApp
                    ? {
                          workspaceAppLeases: this.#workspaceAppLeases,
                          workspaceAppPresence: this.#workspaceAppPresence,
                      }
                    : {}),
                ...(liveBaseUrl === undefined
                    ? {}
                    : { workspaceLiveBaseUrl: liveBaseUrl }),
            }),
            this.#config.serverVersion,
            this.#config.publicBaseUrl,
        );
        const path = instance.path ?? `/${instance.name}/mcp`;

        const previous = this.#registry.register({
            auth: instance.auth ?? { enabled: false, provider: "none" },
            binding,
            path,
        });
        if (workspaceApp) {
            this.#liveRouteCleanups.set(
                instance.name,
                installMcpWorkspaceLiveRoute({
                    contextRegistry: this.#contextRegistry,
                    gateway: instance.gateway,
                    host: this.#httpServer,
                    instanceName: instance.name,
                    leases: this.#workspaceAppLeases,
                    presence: this.#workspaceAppPresence,
                    publicBaseUrl: this.#config.publicBaseUrl,
                    restoreTmuxWaits: async () =>
                        await binding.restoreTmuxWaits(),
                }),
            );
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
            const route = this.#registry
                .list()
                .find((entry) => entry.binding.instanceName === instanceName);
            if (route !== undefined)
                this.#httpServer.unregisterBinding(route.path);
        }
        this.#liveRouteCleanups.get(instanceName)?.();
        this.#liveRouteCleanups.delete(instanceName);
        this.#workspaceAppPresence.revokeInstance(instanceName);
        await this.#workspaceAppLeases.revokeInstance(instanceName);
        const gateway = this.#gateways.get(instanceName);
        if (gateway === undefined) return;
        while (true) {
            const claims =
                await this.#contextRegistry.listAutomaticReentryClaimsForInstance(
                    instanceName,
                );
            if (claims.length === 0) break;
            for (const claim of claims) {
                if (
                    claim.sourceKind === "wait" &&
                    claim.sourceId !== undefined
                ) {
                    if (gateway.disableWaitRecovery === undefined) {
                        throw new Error(
                            `Cannot retire Workspace wait claim ${claim.claimId}.`,
                        );
                    }
                    const wait =
                        gateway.listWaits === undefined
                            ? undefined
                            : (await gateway.listWaits(instanceName)).find(
                                  (entry) => entry.waitId === claim.sourceId,
                              );
                    if (
                        wait !== undefined &&
                        wait.status !== "consumed" &&
                        wait.status !== "cancelled"
                    ) {
                        await gateway.disableWaitRecovery(
                            instanceName,
                            claim.sourceId,
                        );
                    }
                } else if (claim.sourceKind === "goal") {
                    if (gateway.goalContinuation === undefined) {
                        throw new Error(
                            `Cannot retire Workspace Goal claim ${claim.claimId}.`,
                        );
                    }
                    await gateway.goalContinuation(
                        instanceName,
                        {
                            action: "retire",
                            ...(claim.sourceId === undefined
                                ? {}
                                : { goalId: claim.sourceId }),
                        },
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
        if (
            gateway.readGoal !== undefined &&
            gateway.goalContinuation !== undefined
        ) {
            for (const context of await this.#contextRegistry.list()) {
                if (
                    !context.environments.some(
                        (environment) => environment.instance === instanceName,
                    )
                )
                    continue;
                const goal = await gateway.readGoal(
                    instanceName,
                    context.ctxId,
                );
                if (
                    goal?.continuationPending !== true &&
                    goal?.continuationUncertain !== true
                )
                    continue;
                await gateway.goalContinuation(
                    instanceName,
                    { action: "retire", goalId: goal.goalId },
                    context.ctxId,
                );
            }
        }
        const waits =
            gateway.listWaits === undefined
                ? []
                : await gateway.listWaits(instanceName);
        for (const wait of waits) {
            if (wait.status === "consumed" || wait.status === "cancelled")
                continue;
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

    async #reconcileContextCleanup(): Promise<void> {
        for (const context of await this.#contextRegistry.listCleanupPending()) {
            await this.#cleanupTerminalContext(context);
        }
        await this.#runtimeState.environmentCleanup
            .reconcile()
            .catch((error) => console.warn(error));
    }

    async #cleanupTerminalContext(terminal: McpContextRecord): Promise<void> {
        if (terminal.status === "active") {
            throw new Error(
                "Active Context " + terminal.ctxId + " cannot be terminally cleaned.",
            );
        }
        const failures: unknown[] = [];
        const cleanup = async (
            operation: () => Promise<unknown> | unknown,
        ): Promise<void> => {
            try {
                await operation();
            } catch (error) {
                failures.push(error);
            }
        };
        const terminalReason =
            terminal.status === "disabled" ? "disabled" : "expired";

        await cleanup(async () => {
            await this.#workspaceAppLeases.revokeContext(terminal.ctxId);
        });
        await cleanup(() =>
            this.#workspaceAppPresence.revokeContext(terminal.ctxId),
        );

        const contexts = await this.#contextRegistry
            .list()
            .catch((error) => {
                failures.push(error);
                return undefined;
            });
        const now = Date.now();
        const reconciledInstances = new Set<string>();
        for (const environment of terminal.environments) {
            const gateway = this.#gateways.get(environment.instance);
            if (
                gateway !== undefined &&
                !reconciledInstances.has(environment.instance)
            ) {
                reconciledInstances.add(environment.instance);
                if (isMcpGoalGateway(gateway)) {
                    const goal = await gateway
                        .readGoal(environment.instance, terminal.ctxId)
                        .catch((error) => {
                            failures.push(error);
                            return undefined;
                        });
                    if (goal?.status === "active" || goal?.status === "blocked") {
                        await cleanup(async () => {
                            await gateway.manageGoal(
                                environment.instance,
                                { action: "stop" },
                                terminal.ctxId,
                            );
                        });
                    }
                }
                if (gateway.listWaits !== undefined) {
                    const waits = await gateway
                        .listWaits(environment.instance)
                        .catch((error) => {
                            failures.push(error);
                            return [];
                        });
                    for (const wait of waits) {
                        if (wait.createdByCtxId !== terminal.ctxId) continue;
                        if (
                            (wait.status === "waiting" ||
                                wait.status === "detached") &&
                            gateway.cancelWait !== undefined
                        ) {
                            await cleanup(async () => {
                                await gateway.cancelWait!(
                                    environment.instance,
                                    wait.waitId,
                                );
                            });
                        } else if (
                            wait.status === "resolved" &&
                            gateway.consumeWait !== undefined
                        ) {
                            await cleanup(async () => {
                                await gateway.consumeWait!(
                                    environment.instance,
                                    wait.waitId,
                                );
                            });
                        }
                    }
                }
                if (gateway.failContextMessages !== undefined) {
                    await cleanup(async () => {
                        await gateway.failContextMessages!(
                            environment.instance,
                            terminal.ctxId,
                            "Context " +
                                terminal.ctxId +
                                " was " +
                                terminalReason +
                                " before Comment delivery.",
                        );
                    });
                }
                if (gateway.listApprovals !== undefined) {
                    const approvals = await gateway
                        .listApprovals(environment.instance)
                        .catch((error) => {
                            failures.push(error);
                            return [];
                        });
                    for (const approval of approvals) {
                        if (
                            approval.ctxId !== terminal.ctxId ||
                            approval.status !== "pending"
                        ) {
                            continue;
                        }
                        if (gateway.cancelApproval !== undefined) {
                            await cleanup(async () => {
                                await gateway.cancelApproval!(
                                    environment.instance,
                                    approval.approvalId,
                                    "Context " +
                                        terminal.ctxId +
                                        " was " +
                                        terminalReason +
                                        ".",
                                );
                            });
                        } else if (gateway.decideApproval !== undefined) {
                            await cleanup(async () => {
                                await gateway.decideApproval!(
                                    environment.instance,
                                    approval.approvalId,
                                    "deny",
                                );
                            });
                        }
                    }
                }
            }

            if (
                environment.workspace !== undefined &&
                contexts !== undefined
            ) {
                const workspace = environment.workspace;
                const hasOtherActiveContext = contexts.some(
                    (context) =>
                        context.ctxId !== terminal.ctxId &&
                        context.status === "active" &&
                        Date.parse(context.expiresAt) > now &&
                        context.environments.some(
                            (candidate) =>
                                candidate.instance === environment.instance &&
                                candidate.workspace === workspace,
                        ),
                );
                if (!hasOtherActiveContext) {
                    const worker = this.#workers.get(environment.instance);
                    const releaseAlerts = worker?.releaseAlerts;
                    if (releaseAlerts !== undefined && worker !== undefined) {
                        await cleanup(async () => {
                            await releaseAlerts.call(worker, workspace);
                        });
                    } else if (gateway !== undefined) {
                        await cleanup(async () => {
                            await gateway.releaseAlerts(
                                environment.instance,
                                workspace,
                            );
                        });
                    }
                }
            }

            if (
                gateway !== undefined ||
                environment.instance !== terminal.instance
            ) {
                await cleanup(async () => {
                    await this.#contextRegistry.recordEnvironmentCleanup(
                        terminal.ctxId,
                        {
                            instance: environment.instance,
                            kind: "instance_reference",
                        },
                    );
                });
            }
        }

        await cleanup(async () => {
            await this.#runtimeState.environmentCleanup.reconcile(
                terminal.ctxId,
            );
        });
        if (failures.length === 0) {
            await this.#contextRegistry
                .settleCleanup(terminal.ctxId)
                .catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            console.warn(
                new AggregateError(
                    failures,
                    "Context " +
                        terminal.ctxId +
                        " was " +
                        terminalReason +
                        ", but cleanup was incomplete.",
                ),
            );
        }
    }

    get contextAdmin(): {
        referenceInstance(
            ctxId: string,
            instance: string,
        ): Promise<{ current: boolean; handle?: string } | undefined>;
        detachInstance(instance: string): Promise<McpContextRecord[]>;
        disable(ctxId: string): Promise<McpContextRecord>;
        list(): Promise<McpContextRecord[]>;
        renew(ctxId: string): Promise<McpContextRecord>;
        validateForInstance(
            ctxId: string,
            instance: string,
        ): Promise<McpContextRecord>;
    } {
        return {
            referenceInstance: async (ctxId, instance) =>
                await this.#contextRegistry.referenceInstance(ctxId, instance),
            detachInstance: async (instance) => {
                await this.#workspaceAppLeases.revokeInstance(instance);
                this.#workspaceAppPresence.revokeInstance(instance);
                return await this.#contextRegistry.detachInstance(instance);
            },
            disable: async (ctxId) => {
                const disabled = await this.#contextRegistry.disable(ctxId);
                await this.#cleanupTerminalContext(disabled);
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
                await this.#contextRegistry.validateForInstance(
                    ctxId,
                    instance,
                ),
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
