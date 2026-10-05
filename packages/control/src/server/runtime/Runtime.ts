import {
    createToolCallRuntime,
    type ToolCallApi,
} from "@portable-devshell/core/toolcall";

import {
    type ContextTransport,
    type ControlConfig,
    type Endpoint,
    type ServerTransport,
} from "@portable-devshell/shared";

import { mcpAllInstances, mcpTools } from "@portable-devshell/mcp/tool";
import type { InstanceRegistry } from "@portable-devshell/core";
import type { ConfigChangeHub } from "../../config/change/Config.js";
import type { ConfigEditorCoordinator } from "../../config/editor/index.js";
import type { InstanceEditorCoordinator } from "../../instance/editor/index.js";
import type { InstanceCreateCoordinator } from "../../instance/editor/create/index.js";
import { DebugPatchService } from "../../debug/Service.js";
import { CliExtensionCommandService } from "../../extension/api/point/cli/command/Service.js";
import { TuiExtensionPageService } from "../../extension/api/point/tui/Endpoint.js";
import {
    type ConnectionModule,
    ProcessSubscriptionManager,
} from "@portable-devshell/core";
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
import { ControlRouteRegistry } from "../Route.js";
import type { ArtifactModule } from "../../artifact/Module.js";
import { installArtifactTools } from "../../artifact/tool/Runtime.js";
import {
    contextToolDefinitions,
    createContextRouteModule,
    installContextTools,
    type ContextService,
} from "@portable-devshell/core/context";
import type { McpControlModule } from "../mcp/Module.js";
import { McpExtensionService } from "../../extension/api/point/mcp/Service.js";
import { ControlWebRuntime } from "../web/Runtime.js";

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
    configEditor: ConfigEditorCoordinator;
    extensionPaths: ExtensionPathLayout;
    extensions: ExtensionHost;
    instanceCreate: InstanceCreateCoordinator;
    instanceEditor: InstanceEditorCoordinator;
    instances: InstanceRegistry;
    mcp: McpControlModule;
    restart: () => Promise<void>;
    reverse: ConnectionModule;
    processSubscriptions?: ProcessSubscriptionManager;
    shutdown: () => Promise<void>;
    socketPath: string;
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
    readonly #instanceEditor: InstanceEditorCoordinator;
    readonly #mcp: McpControlModule;
    readonly #reverse: ConnectionModule;
    readonly #routes: ControlRouteRegistry;
    readonly #socketListener: ControlSocketListener;
    readonly #toolCallHookUnregister: Array<() => void>;
    readonly #toolCalls: ToolCallApi;
    readonly #web: ControlWebRuntime;

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
        this.#instanceEditor = options.instanceEditor;
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
        const contextToolRegistration = mcpTools.register(
            mcpAllInstances,
            contextToolDefinitions(),
        );
        this.#toolCallHookUnregister.push(() =>
            contextToolRegistration.dispose(),
        );
        this.#toolCallHookUnregister.push(
            installContextTools(options.contexts, toolCalls.hooks, {
                instances: options.instances,
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
            controlPorts: [createContextRouteModule(options.contexts)],
            debug: this.#debug,
            extension: this.#extensionControl,
            extensionRoutes: new ControlExtensionRouteService(this.#extensions),
            instanceCreate: options.instanceCreate,
            instanceEditor: options.instanceEditor,
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
        this.#instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await this.#extensions.retireInstanceGeneration(instance.name);
            },
        );
        this.#instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await this.#debug.retireInstance(instance.name);
            },
        );
        this.#instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await this.#routes.retireInstance(instance.name);
            },
        );
        this.#socketListener = new ControlSocketListener({
            socketPath: options.socketPath,
        });
        this.#web = new ControlWebRuntime({
            extensions: this.#extensions,
            host: this.#mcp,
            paths: this.#extensionPaths,
        });
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
            await this.#web.prepare();
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
            await this.#instanceEditor.reconcileCleanupDebt();
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
        this.#web.stop();
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
}
