import {
    createToolCallRuntime,
    createToolCallTargetTransport,
    type ToolCallApi,
    type ToolCallRuntime,
} from "@portable-devshell/shared";

import {
    type ContextTransport,
    type ControlConfig,
    createEnvironmentTransport,
    createProcessTransport,
    type Endpoint,
    type ServerTransport,
} from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../instance/Api.js";
import type { InstanceChangeHub } from "../../instance/Change.js";
import type { ConfigChangeHub } from "../../config/change/Config.js";
import type { ConfigEditorCoordinator } from "../../config/editor/index.js";
import type { InstanceEditorCoordinator } from "../../instance/editor/index.js";
import type { InstanceCreateCoordinator } from "../../instance/editor/create/index.js";
import { createDebugRuntime } from "../../debug/index.js";
import type { DebugRuntime } from "../../debug/Api.js";
import { CliExtensionCommandService } from "../../extension/api/point/cli/command/index.js";
import { TuiExtensionPageService } from "../../extension/api/point/tui/index.js";
import type { ReverseCredentials } from "../../instance/reverse/Credentials.js";
import type { ReverseIngress } from "../reverse/Ingress.js";
import { ControlExtensionRouteService } from "../../extension/api/point/control/Dispatch.js";
import { WebApplicationCatalog } from "../web/extension/application/Catalog.js";
import { WebExtensionPageService } from "../web/extension/page/Service.js";
import type { ExtensionRuntime } from "../../extension/Api.js";
import { ToolCallExtensionBinding } from "../../extension/api/point/toolcall/index.js";
import { ToolCallSecretRewrite } from "../../extension/api/interface/secret/index.js";
import type { BuiltinExtensionSource } from "../../extension/install/BuiltinSource.js";
import { createOperationalOverviewRuntime } from "../../overview/index.js";
import { OperationalOverviewInstanceCollector } from "../../overview/collector/Instance.js";
import { ControlTransportServer } from "../transport/endpoint/Server.js";
import type { ControlTransportListener } from "../transport/channel/Listener.js";
import { ControlSocketListener } from "../transport/channel/Socket.js";
import { ControlRouteRegistry } from "../Route.js";
import type { ArtifactRuntime } from "../../artifact/Api.js";
import { installArtifactTools } from "../../artifact/tool/index.js";
import {
    createContextRouteModule,
    installContextTools,
} from "../../context/Public.js";
import type { ContextRuntime } from "../../context/Api.js";
import type { McpControlModule } from "../mcp/Module.js";
import { McpExtensionService } from "../../extension/api/point/mcp/index.js";
import { ControlWebRuntime } from "../web/Runtime.js";
import type { ToolCallRegistry } from "../../toolcall/Api.js";

export interface ControlRuntimeOptions {
    contexts: ContextRuntime;
    contextTransport: ContextTransport;
    internalControl: {
        endpoint: Endpoint;
        server: ServerTransport;
    };
    artifact: ArtifactRuntime;
    builtinExtensionSources?: readonly BuiltinExtensionSource[];
    config?: () => ControlConfig;
    configChanges: ConfigChangeHub;
    configEditor: ConfigEditorCoordinator;
    extensions: ExtensionRuntime;
    instanceCreate: InstanceCreateCoordinator;
    instanceEditor: InstanceEditorCoordinator;
    instanceChanges: InstanceChangeHub;
    instances: InstanceRegistry;
    mcp: McpControlModule;
    toolCalls: ToolCallRegistry;
    restart: () => Promise<void>;
    reverse: {
        credentials?: ReverseCredentials;
        ingress?: ReverseIngress;
    };
    shutdown: () => Promise<void>;
    socketPath: string;
    web: ControlWebRuntime;
}

export class ControlRuntime {
    readonly #toolCallRuntime: ToolCallRuntime;
    readonly #contexts: ContextRuntime;
    readonly #artifact: ArtifactRuntime;
    readonly #builtinExtensionSources: readonly BuiltinExtensionSource[];
    readonly #transport: ControlTransportServer;
    readonly #debug: DebugRuntime;
    readonly #extensions: ExtensionRuntime;
    readonly #instances: InstanceRegistry;
    readonly #internalControlEndpoint: Endpoint;
    readonly #internalControlServer: ServerTransport;
    readonly #instanceEditor: InstanceEditorCoordinator;
    readonly #mcp: McpControlModule;
    readonly #reverseCredentials?: ReverseCredentials;
    readonly #reverseIngress?: ReverseIngress;
    readonly #routes: ControlRouteRegistry;
    readonly #socketListener: ControlSocketListener;
    readonly #unsubscribeConfigInstanceChanges: () => void;
    readonly #toolCallHookUnregister: Array<() => void>;
    readonly #toolCallRegistryUnbind: () => void;
    readonly #toolCalls: ToolCallApi;
    readonly #web: ControlWebRuntime;

    constructor(options: ControlRuntimeOptions) {
        this.#contexts = options.contexts;
        this.#artifact = options.artifact;
        this.#builtinExtensionSources = Object.freeze([
            ...(options.builtinExtensionSources ?? []),
        ]);
        this.#extensions = options.extensions;
        this.#instances = options.instances;
        this.#internalControlEndpoint = options.internalControl.endpoint;
        this.#internalControlServer = options.internalControl.server;
        this.#instanceEditor = options.instanceEditor;
        const toolCalls = createToolCallRuntime({
            resolveTarget: (name) =>
                createToolCallTargetTransport(
                    options.internalControl.endpoint,
                    name,
                ),
        });
        this.#toolCallRegistryUnbind = options.toolCalls.bind(toolCalls.hooks);
        this.#toolCallRuntime = toolCalls;
        this.#toolCalls = toolCalls.api;
        const extensionToolCalls = new ToolCallExtensionBinding(
            this.#extensions,
            new ToolCallSecretRewrite(options.config),
        );
        this.#toolCallHookUnregister = [
            extensionToolCalls.install(options.toolCalls),
        ];
        this.#mcp = options.mcp;
        this.#mcp.setToolCalls(this.#toolCalls);
        const extensionMcpTools = new McpExtensionService(this.#extensions);
        this.#toolCallHookUnregister.push(
            extensionMcpTools.install(options.toolCalls),
        );
        this.#reverseCredentials = options.reverse.credentials;
        this.#reverseIngress = options.reverse.ingress;
        this.#debug = createDebugRuntime();
        const modelCliCommands = new CliExtensionCommandService(
            this.#extensions,
            {
                surface: "model",
            },
        );
        const modelCommands = (instance: string): readonly string[] => {
            const allowed =
                options.instances.get(instance)?.config.modelExtensions ?? [];
            return modelCliCommands
                .list()
                .filter((command) => allowed.includes(command.extensionId))
                .map((command) => command.id);
        };
        this.#toolCallHookUnregister.push(
            installContextTools(options.contexts.api, options.toolCalls, {
                environment: (name) =>
                    createEnvironmentTransport(
                        options.internalControl.endpoint,
                        name,
                    ),
                leaseInstance: (name) => {
                    const descriptor = options.instances.get(name);
                    if (descriptor === undefined) throw new Error(name);
                    return descriptor.lifecycle.acquireLease();
                },
                modelCommands,
                process: (name) =>
                    createProcessTransport(options.internalControl.endpoint, name),
            }),
        );
        this.#toolCallHookUnregister.push(
            installArtifactTools(
                options.artifact.service,
                options.instances,
                options.instanceChanges,
                options.toolCalls,
            ),
        );
        this.#unsubscribeConfigInstanceChanges = options.configChanges.onChange(
            (change) => {
                if (
                    change.paths.some(
                        (path) =>
                            path === "instances" ||
                            path.startsWith("instances."),
                    )
                ) {
                    options.instanceChanges.publish("config");
                }
            },
        );
        const extensionRoutes = new ControlExtensionRouteService(this.#extensions);
        this.#routes = new ControlRouteRegistry({
            artifact: options.artifact.service,
            cliCommands: new CliExtensionCommandService(this.#extensions, {
                surface: "native",
            }),
            config: options.configEditor,
            configChanges: options.configChanges,
            ...(options.config === undefined
                ? {}
                : { configuredInstances: () => options.config!().instances }),
            controlPorts: [createContextRouteModule(options.contexts.api)],
            debug: this.#debug,
            extension: this.#extensions.control,
            extensionRoutes,
            instanceCreate: options.instanceCreate,
            instanceEditor: options.instanceEditor,
            instanceChanges: options.instanceChanges,
            instances: options.instances,
            mcpStatus: () => options.mcp.status(),
            oauthApprovals: () => options.mcp.oauthApprovals,
            overview: createOperationalOverviewRuntime({
                instanceCollector: new OperationalOverviewInstanceCollector({
                    activityLimit: 20,
                    endpoint: options.internalControl.endpoint,
                }),
                instances: options.instances,
                oauthApprovals: () => options.mcp.oauthApprovals,
            }),
            restart: options.restart,
            reverse: this.#reverseCredentials,
            shutdown: options.shutdown,
            tuiPages: new TuiExtensionPageService(this.#extensions),
            webApplications: new WebApplicationCatalog(this.#extensions),
            webPages: new WebExtensionPageService(this.#extensions),
        });
        this.#instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await this.#extensions.retireInstanceGeneration(instance.name);
            },
        );
        this.#instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await extensionRoutes.retireInstance(instance.name);
            },
        );
        this.#socketListener = new ControlSocketListener({
            socketPath: options.socketPath,
        });
        this.#web = options.web;
        const listeners: ControlTransportListener[] = [this.#socketListener];
        if (this.#web.listener !== undefined)
            listeners.push(this.#web.listener);
        this.#transport = new ControlTransportServer({
            listeners,
            routes: this.#routes,
        });
        this.#mcp.setWebConfigApplier?.(
            async (previous, next) =>
                await this.#web.replace(previous, next, this.#transport),
        );
        this.#mcp.setMcpConfigApplier?.(async (_previous, next) => {
            const retired = await this.#mcp.replaceMcpHost(_previous, next);
            try {
                const host = this.#mcp.host;
                if (host !== undefined && this.#reverseIngress !== undefined) {
                    if (next.mcp.publicBaseUrl !== undefined) {
                        this.#reverseCredentials?.setPublicBaseUrl(
                            next.mcp.publicBaseUrl,
                        );
                        this.#reverseIngress.setPublicBaseUrl(
                            next.mcp.publicBaseUrl,
                        );
                    }
                    this.#reverseIngress.install(host.server);
                }
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
                    if (host !== undefined && this.#reverseIngress !== undefined) {
                        if (_previous.mcp.publicBaseUrl !== undefined) {
                            this.#reverseCredentials?.setPublicBaseUrl(
                                _previous.mcp.publicBaseUrl,
                            );
                            this.#reverseIngress.setPublicBaseUrl(
                                _previous.mcp.publicBaseUrl,
                            );
                        }
                        this.#reverseIngress.install(host.server);
                    }
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
            await this.#artifact.start();
            await this.#web.prepare();
            await this.#contexts.initialize();
            await this.#transport.start();
            await this.#internalControlServer.hello();
            await this.#extensions.start();
            for (const source of this.#builtinExtensionSources) {
                await this.#extensions.installBuiltin(
                    source.id,
                    source.path,
                );
            }
            await this.#instanceEditor.reconcileCleanupDebt();
            await this.#mcp.start();
            if (this.#reverseIngress !== undefined && this.#mcp.host !== undefined)
                this.#reverseIngress.install(this.#mcp.host.server);
            await this.#web.startHost();
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
            this.#toolCallRegistryUnbind();
        } catch (error) {
            failures.push(error);
        }
        try {
            this.#internalControlEndpoint.close();
        } catch (error) {
            failures.push(error);
        }
        await this.#transport.close().catch((error) => failures.push(error));
        await this.#web.stopHost().catch((error) => failures.push(error));
        await this.#mcp.stop().catch((error) => failures.push(error));
        await this.#extensions.stop().catch((error) => failures.push(error));
        await this.#debug.close().catch((error) => failures.push(error));
        this.#web.stop();
        try {
            this.#reverseIngress?.stop();
        } catch (error) {
            failures.push(error);
        }
        await this.#artifact.stop().catch((error) => failures.push(error));
        this.#toolCallRuntime.close();
        this.#contexts.close();
        try {
            this.#unsubscribeConfigInstanceChanges();
        } catch (error) {
            failures.push(error);
        }
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
}
