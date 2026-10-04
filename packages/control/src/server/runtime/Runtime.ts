import { join } from "node:path";

import {
    createToolCallRuntime,
    type ToolCallApi,
} from "@portable-devshell/core/toolcall";

import {
    controlRemoteRpcPath,
    controlWebBasePath,
    type ContextTransport,
    type ControlConfig,
    type Endpoint,
    type ServerTransport,
} from "@portable-devshell/shared";

import {
    McpOAuthProtectedResource,
    type HttpHost,
} from "@portable-devshell/mcp";
import type { InstanceRegistry } from "@portable-devshell/core";
import type { ConfigChangeHub } from "../../config/change/Config.js";
import { DebugPatchService } from "../../debug/Service.js";
import { CliExtensionCommandService } from "../../extension/api/point/cli/command/Service.js";
import { TuiExtensionPageService } from "../../extension/api/point/tui/Endpoint.js";
import { ProcessSubscriptionManager } from "@portable-devshell/core";
import { ExtensionControlService } from "../../extension/manager/Operations.js";
import { ControlExtensionRouteService } from "../../extension/api/point/control/Dispatch.js";
import { WebApplicationCatalog } from "../web/extension/application/Catalog.js";
import { WebExtensionPageService } from "../web/extension/page/Service.js";
import type { ExtensionHost } from "../../extension/host/Host.js";
import { ExtensionInstallService } from "../../extension/install/Service.js";
import { ToolCallExtensionBinding } from "../../extension/api/point/toolcall/Binding.js";
import { ToolCallSecretRewrite } from "../../extension/api/interface/secret/Rewrite.js";
import type { ExtensionPathLayout } from "../../extension/state/Layout.js";
import type { BuiltinExtensionSource } from "../../extension/install/BuiltinSource.js";
import { OperationalOverviewService } from "../../overview/Service.js";
import { ControlTransportServer } from "../transport/endpoint/Server.js";
import type { ControlTransportListener } from "../transport/channel/Listener.js";
import { ControlSocketListener } from "../transport/channel/Socket.js";
import { resolveControlWebAssetsDirectory } from "../web/Assets.js";
import { ControlWebOAuthFlow } from "../web/auth/OAuth.js";
import { ControlWebSessionService } from "../web/auth/Session.js";
import { ControlWebSocketAccessService } from "../web/auth/Access.js";
import { ControlWebSocketListener } from "../web/Socket.js";
import { ExtensionWebGateway } from "../web/extension/application/Gateway.js";
import { ControlRouteComposition } from "../Route.js";
import type { ArtifactModule } from "../../artifact/Module.js";
import { installArtifactTools } from "../../artifact/tool/Runtime.js";
import {
    createContextRouteModule,
    installContextTools,
    type ContextService,
} from "@portable-devshell/core/context";
import type { McpControlModule } from "../mcp/Module.js";
import { toMcpOAuthApprovalConfig } from "../mcp/Runtime.js";
import { McpExtensionService } from "../../extension/api/point/mcp/Service.js";

export interface ControlRuntimeOptions {
    contexts: ContextService;
    contextTransport: ContextTransport;
    internalControl: {
        endpoint: Endpoint;
        server: ServerTransport;
    };
    artifact: ArtifactModule;
    builtinExtensionSources?: readonly BuiltinExtensionSource[];
    config?: () => ControlConfig;
    configChanges: ConfigChangeHub;
    extensionPaths: ExtensionPathLayout;
    extensions: ExtensionHost;
    instances: InstanceRegistry;
    mcp: McpControlModule;
    restart: () => Promise<void>;
    reverse: ConnectionModule;
    processSubscriptions?: ProcessSubscriptionManager;
    shutdown: () => Promise<void>;
    socketPath: string;
}

interface ControlWebRuntime {
    flow?: ControlWebOAuthFlow;
    host: HttpHost;
    listener: ControlWebSocketListener;
}

export class ControlRuntime {
    readonly #contexts: ContextService;
    readonly #artifact: ArtifactModule;
    readonly #builtinExtensionSources: readonly BuiltinExtensionSource[];
    readonly #transport: ControlTransportServer;
    readonly #debug: DebugPatchService;
    readonly #extensionControl: ExtensionControlService;
    readonly #extensionPaths: ExtensionPathLayout;
    readonly #extensions: ExtensionHost;
    readonly #instances: InstanceRegistry;
    readonly #internalControlEndpoint: Endpoint;
    readonly #internalControlServer: ServerTransport;
    readonly #mcp: McpControlModule;
    readonly #reverse: ConnectionModule;
    readonly #routes: ControlRouteComposition;
    readonly #socketListener: ControlSocketListener;
    readonly #toolCallHookUnregister: Array<() => void>;
    readonly #toolCalls: ToolCallApi;
    #webListener?: ControlWebSocketListener;
    #webFlow?: ControlWebOAuthFlow;
    #webFlowUninstall?: () => void;

    constructor(options: ControlRuntimeOptions) {
        this.#contexts = options.contexts;
        this.#artifact = options.artifact;
        this.#builtinExtensionSources = Object.freeze([
            ...(options.builtinExtensionSources ?? []),
        ]);
        this.#extensionPaths = options.extensionPaths;
        this.#extensions = options.extensions;
        this.#extensionControl = new ExtensionControlService({
            host: this.#extensions,
            installer: new ExtensionInstallService({
                host: this.#extensions,
                paths: this.#extensionPaths,
            }),
        });
        this.#instances = options.instances;
        this.#internalControlEndpoint = options.internalControl.endpoint;
        this.#internalControlServer = options.internalControl.server;
        const toolCalls = createToolCallRuntime({});
        this.#toolCalls = toolCalls.api;
        const extensionToolCalls = new ToolCallExtensionBinding(
            this.#extensions,
            new ToolCallSecretRewrite(options.config),
        );
        this.#toolCallHookUnregister = [
            extensionToolCalls.install(toolCalls.hooks),
        ];
        this.#mcp = options.mcp;
        const extensionMcpTools = new McpExtensionService(this.#extensions);
        this.#toolCallHookUnregister.push(
            extensionMcpTools.install(toolCalls.hooks),
        );
        this.#reverse = options.reverse;
        this.#debug = new DebugPatchService(options.instances);
        const processSubscriptions =
            options.processSubscriptions ?? new ProcessSubscriptionManager();
        const modelCliCommands = new CliExtensionCommandService(
            this.#extensions,
            {
                surface: "model",
            },
        );
        const modelCommands = (instance: string): readonly string[] => {
            const allowed =
                options.instances.get(instance)?.modelExtensions ?? [];
            return modelCliCommands
                .list()
                .filter((command) => allowed.includes(command.extensionId))
                .map((command) => command.id);
        };
        this.#toolCallHookUnregister.push(
            installContextTools(options.contexts, toolCalls.hooks, {
                modelCommands,
            }),
        );
        this.#toolCallHookUnregister.push(
            installArtifactTools(
                options.artifact.service,
                options.instances,
                toolCalls.hooks,
            ),
        );
        this.#routes = new ControlRouteComposition({
            artifact: options.artifact.service,
            cliCommands: new CliExtensionCommandService(this.#extensions, {
                surface: "native",
            }),
            config: options.mcp.configEditor,
            configChanges: options.configChanges,
            ...(options.config === undefined
                ? {}
                : { configuredInstances: () => options.config!().instances }),
            controlPorts: [createContextRouteModule(options.contexts)],
            debug: this.#debug,
            extension: this.#extensionControl,
            extensionRoutes: new ControlExtensionRouteService(this.#extensions),
            instanceCreate: options.mcp.instanceCreate,
            instanceEditor: options.mcp.instanceEditor,
            instances: options.instances,
            mcpStatus: () => options.mcp.status(),
            oauthApprovals: () => options.mcp.oauthApprovals,
            overview: new OperationalOverviewService({
                instances: options.instances,
                oauthApprovals: () => options.mcp.oauthApprovals,
            }),
            restart: options.restart,
            reverse: options.reverse.service,
            processSubscriptions,
            shutdown: options.shutdown,
            toolCalls: this.#toolCalls,
            toolProvenance: options.mcp.toolProvenance,
            tuiPages: new TuiExtensionPageService(this.#extensions),
            webApplications: new WebApplicationCatalog(this.#extensions),
            webPages: new WebExtensionPageService(this.#extensions),
        });
        this.#mcp.instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await this.#extensions.retireInstanceGeneration(instance.name);
            },
        );
        this.#mcp.instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await this.#debug.retireInstance(instance.name);
            },
        );
        this.#mcp.instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await this.#routes.retireInstance(instance.name);
            },
        );
        this.#socketListener = new ControlSocketListener({
            socketPath: options.socketPath,
        });
        const listeners: ControlTransportListener[] = [this.#socketListener];
        const webRuntime = this.#createWebRuntime();
        if (webRuntime !== undefined) listeners.push(webRuntime.listener);
        this.#webListener = webRuntime?.listener;
        this.#webFlow = webRuntime?.flow;
        this.#transport = new ControlTransportServer({
            listeners,
            routes: this.#routes,
        });
        this.#mcp.setWebConfigApplier?.(
            async (previous, next) =>
                await this.#replaceWebListener(previous, next),
        );
        this.#mcp.setMcpConfigApplier?.(async (_previous, next) => {
            const retired = await this.#mcp.replaceMcpHost(_previous, next);
            try {
                const host = this.#mcp.host;
                if (host !== undefined)
                    this.#reverse.install(host.server, next.mcp.publicBaseUrl);
                await retired?.stop();
            } catch (error) {
                const rollbackFailures: unknown[] = [];
                await this.#mcp
                    .restoreMcpHost(retired, _previous)
                    .catch((rollbackError) => {
                        rollbackFailures.push(rollbackError);
                    });
                try {
                    const host = this.#mcp.host;
                    if (host !== undefined)
                        this.#reverse.install(
                            host.server,
                            _previous.mcp.publicBaseUrl,
                        );
                } catch (rollbackError) {
                    rollbackFailures.push(rollbackError);
                }
                if (rollbackFailures.length > 0) {
                    throw new AggregateError(
                        [error, ...rollbackFailures],
                        "MCP hot replacement failed and runtime rollback was incomplete.",
                    );
                }
                throw error;
            }
        });
    }

    async start(): Promise<void> {
        try {
            await this.#webFlow?.warmup();
            const webHost = this.#mcp.webHost;
            if (this.#webFlow !== undefined && webHost !== undefined) {
                this.#webFlowUninstall = this.#webFlow.install(webHost);
            }
            await this.#contexts.initialize();
            await this.#transport.start();
            await this.#internalControlServer.hello();
            await this.#extensions.start();
            for (const source of this.#builtinExtensionSources) {
                await this.#extensionControl.installBuiltin(
                    source.id,
                    source.path,
                );
            }
            await this.#mcp.prepare();
            await this.#mcp.start();
            await this.#contexts.reconcile();
        } catch (error) {
            try {
                await this.stop();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Control runtime startup failed and rollback was incomplete.",
                );
            }
            throw error;
        }
    }

    async stop(): Promise<void> {
        const failures: unknown[] = [];
        for (const unregister of this.#toolCallHookUnregister
            .splice(0)
            .reverse()) {
            try {
                unregister();
            } catch (error) {
                failures.push(error);
            }
        }
        try {
            this.#internalControlEndpoint.close();
        } catch (error) {
            failures.push(error);
        }
        await this.#transport.close().catch((error) => failures.push(error));
        await this.#mcp.stop().catch((error) => failures.push(error));
        await this.#extensions.stop().catch((error) => failures.push(error));
        await this.#debug.dispose().catch((error) => failures.push(error));
        this.#webFlowUninstall?.();
        this.#webFlow = undefined;
        this.#webFlowUninstall = undefined;
        try {
            this.#reverse.stop();
        } catch (error) {
            failures.push(error);
        }
        await this.#artifact.stop().catch((error) => failures.push(error));
        await this.#instances
            .stopOwned()
            .catch((error) => failures.push(error));
        try {
            this.#routes.dispose();
        } catch (error) {
            failures.push(error);
        }
        await this.#socketListener
            .removeEndpoint()
            .catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "Control runtime failed to stop cleanly.",
            );
        }
    }

    #createWebRuntime(): ControlWebRuntime | undefined {
        const http = this.#mcp.webHost;
        if (http === undefined || !this.#mcp.webEnabled) return undefined;
        const basePath = controlWebBasePath(this.#mcp.webPublicBaseUrl);
        const secureCookie =
            this.#mcp.webPublicBaseUrl?.startsWith("https://") ?? false;
        const sessions = new ControlWebSessionService({
            auth: this.#mcp.webAuth,
            basePath,
            secureCookie,
        });
        const flow = this.#createWebOAuthFlow(
            http,
            basePath,
            secureCookie,
            sessions,
        );
        const access = new ControlWebSocketAccessService({
            sessions,
            ...(flow === undefined
                ? {}
                : {
                      onBearerRevoked: (listener) =>
                          flow.onAccessRevoked(listener),
                      verifyBearer: async (token: string) =>
                          await flow.verifyAccessToken(token),
                  }),
        });
        return {
            ...(flow === undefined ? {} : { flow }),
            host: http,
            listener: new ControlWebSocketListener({
                access,
                assetDirectory: resolveControlWebAssetsDirectory(),
                basePath,
                http,
                remotePath: controlRemoteRpcPath(this.#mcp.webPublicBaseUrl),
                routeInstaller: (host, webSessions) =>
                    new ExtensionWebGateway({
                        basePath: `${basePath}/extensions`,
                        extensions: this.#extensions,
                        loginPath: `${basePath}/`,
                        paths: this.#extensionPaths,
                    }).install(host, webSessions),
                sessions,
            }),
        };
    }

    #createWebOAuthFlow(
        http: HttpHost,
        basePath: string,
        secureCookie: boolean,
        sessions: ControlWebSessionService,
    ): ControlWebOAuthFlow | undefined {
        const auth = this.#mcp.webAuth;
        const publicBaseUrl = this.#mcp.webPublicBaseUrl;
        if (auth.mode !== "oauth2" || publicBaseUrl === undefined)
            return undefined;

        const mcpHost = this.#mcp.host;
        const reused = sameOrigin(publicBaseUrl, this.#mcp.publicBaseUrl)
            ? mcpHost?.oauthProtectedResource
            : undefined;
        const providerConfig = {
            documentationUrl: auth.oauth2.documentationUrl,
            requiredScopes: [...auth.oauth2.requiredScopes],
            resourceName: auth.oauth2.resourceName,
        };
        const protectedResource =
            reused ??
            new McpOAuthProtectedResource(
                providerConfig,
                new URL(publicBaseUrl).origin,
                this.#mcp.webOauthDir,
                {
                    approval: toMcpOAuthApprovalConfig(this.#mcp.oauthApproval),
                    trustProxy: isLoopbackPublicBaseUrl(publicBaseUrl),
                },
            );

        return new ControlWebOAuthFlow({
            basePath,
            clientStateFile: join(this.#mcp.webOauthDir, "client.json"),
            config: providerConfig,
            installProvider: reused === undefined || http !== mcpHost?.server,
            ownsProvider: reused === undefined,
            protectedResource,
            publicBaseUrl,
            secureCookie,
            sessions,
        });
    }

    async #replaceWebListener(
        previousConfig: import("@portable-devshell/shared").ControlConfig,
        nextConfig: import("@portable-devshell/shared").ControlConfig,
    ): Promise<void> {
        const previousHost = await this.#mcp.replaceWebHost(
            previousConfig,
            nextConfig,
        );
        const previousListener = this.#webListener;
        const previousFlow = this.#webFlow;
        const previousFlowUninstall = this.#webFlowUninstall;
        let previousFlowRemoved = false;
        let nextRuntime: ControlWebRuntime | undefined;
        let nextFlowUninstall: (() => void) | undefined;
        try {
            nextRuntime = this.#createWebRuntime();
            if (previousListener === undefined || nextRuntime === undefined) {
                throw new Error(
                    "Web listener hot replacement requires Web to remain enabled.",
                );
            }
            await nextRuntime.flow?.warmup();
            if (previousFlowUninstall !== undefined) {
                previousFlowUninstall();
                previousFlowRemoved = true;
            }
            nextFlowUninstall = nextRuntime.flow?.install(nextRuntime.host);
            await this.#transport.replaceListener(
                previousListener,
                nextRuntime.listener,
            );
            this.#webListener = nextRuntime.listener;
            this.#webFlow = nextRuntime.flow;
            this.#webFlowUninstall = nextFlowUninstall;
            await this.#mcp
                .stopRetiredWebHost(previousHost)
                .catch(reportRetiredWebHostFailure);
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            try {
                nextFlowUninstall?.();
            } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
            }
            await this.#mcp
                .restoreWebHost(previousHost, previousConfig)
                .catch((rollbackError) => {
                    rollbackFailures.push(rollbackError);
                });
            this.#webListener = previousListener;
            this.#webFlow = previousFlow;
            if (
                previousFlowRemoved &&
                previousFlow !== undefined &&
                this.#mcp.webHost !== undefined
            ) {
                try {
                    await previousFlow.warmup();
                    this.#webFlowUninstall = previousFlow.install(
                        this.#mcp.webHost,
                    );
                } catch (rollbackError) {
                    rollbackFailures.push(rollbackError);
                }
            } else {
                this.#webFlowUninstall = previousFlowUninstall;
            }
            if (rollbackFailures.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "Web hot replacement failed and runtime rollback was incomplete.",
                );
            }
            throw error;
        }
    }
}

function isLoopbackPublicBaseUrl(publicBaseUrl: string): boolean {
    try {
        const host = new URL(publicBaseUrl).hostname;
        return host === "127.0.0.1" || host === "::1" || host === "localhost";
    } catch {
        return false;
    }
}

function sameOrigin(
    left: string | undefined,
    right: string | undefined,
): boolean {
    if (left === undefined || right === undefined) return false;
    try {
        return new URL(left).origin === new URL(right).origin;
    } catch {
        return false;
    }
}

function reportRetiredWebHostFailure(error: unknown): void {
    console.warn(error instanceof Error ? error : new Error(String(error)));
}
