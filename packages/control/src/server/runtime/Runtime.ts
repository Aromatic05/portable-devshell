import {
    createToolCallRuntime,
    type ToolCallApi,
    type ToolCallRuntime,
    createToolRouteModule,
} from "@portable-devshell/core/toolcall";
import { registerApprovalToolCallReview, createApprovalRouteModule } from "@portable-devshell/core/approval";
import { createGoalTaskRouteModule, createTodoTaskRouteModule } from "@portable-devshell/core/task";
import { createTerminalRouteModule } from "@portable-devshell/core/terminal";
import { installTodoTools, installWaitToolCallRewrite } from "@portable-devshell/core/task";

import {
    type ContextTransport,
    type ControlConfig,
    type Endpoint,
    type ServerTransport,
} from "@portable-devshell/shared";

import type { InstanceRegistry, WorkerInstance } from "@portable-devshell/core/instance";
import type { InstanceChangeHub } from "../../instance/Change.js";
import type { ConfigChangeHub } from "../../config/change/Config.js";
import type { ConfigEditorCoordinator } from "../../config/editor/index.js";
import type { InstanceEditorCoordinator } from "../../instance/editor/index.js";
import type { InstanceCreateCoordinator } from "../../instance/editor/create/index.js";
import { createDebugRuntime, type DebugRuntime } from "../../debug/Public.js";
import { CliExtensionCommandService } from "../../extension/api/point/cli/command/Service.js";
import { TuiExtensionPageService } from "../../extension/api/point/tui/Endpoint.js";
import { type ConnectionModule, ProcessSubscriptionManager } from "@portable-devshell/core/instance";
import { ExtensionControlService } from "../../extension/manager/Operations.js";
import { ControlExtensionRouteService } from "../../extension/api/point/control/Dispatch.js";
import { WebApplicationCatalog } from "../web/extension/application/Catalog.js";
import { WebExtensionPageService } from "../web/extension/page/Service.js";
import type { ExtensionRuntime } from "../../extension/Public.js";
import { ExtensionInstallService } from "../../extension/install/Service.js";
import { ToolCallExtensionBinding } from "../../extension/api/point/toolcall/Binding.js";
import { ToolCallSecretRewrite } from "../../extension/api/interface/secret/Rewrite.js";
import type { ExtensionPathLayout } from "../../extension/state/Layout.js";
import type { BuiltinExtensionSource } from "../../extension/install/BuiltinSource.js";
import { createOperationalOverviewRuntime } from "../../overview/Public.js";
import { OperationalOverviewInstanceCollector } from "../../overview/collector/Instance.js";
import { ControlTransportServer } from "../transport/endpoint/Server.js";
import type { ControlTransportListener } from "../transport/channel/Listener.js";
import { ControlSocketListener } from "../transport/channel/Socket.js";
import { ControlRouteRegistry } from "../Route.js";
import type { ArtifactRuntime } from "../../artifact/Public.js";
import { installArtifactTools } from "../../artifact/tool/Runtime.js";
import {
    createContextRouteModule,
    installContextTools,
    type ContextRuntime,
} from "@portable-devshell/core/context";
import type { McpControlModule } from "../mcp/Module.js";
import { McpExtensionService } from "../../extension/api/point/mcp/Service.js";
import { ControlWebRuntime } from "../web/Runtime.js";
import type { InstanceRuntimeRegistry } from "../../instance/Public.js";
import type { ToolCallRegistry } from "../../toolcall/Public.js";

export interface ControlRuntimeOptions {
    instanceRuntimes: InstanceRuntimeRegistry;
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
    extensionPaths: ExtensionPathLayout;
    extensions: ExtensionRuntime;
    instanceCreate: InstanceCreateCoordinator;
    instanceEditor: InstanceEditorCoordinator;
    instanceChanges: InstanceChangeHub;
    instances: InstanceRegistry;
    mcp: McpControlModule;
    toolCalls: ToolCallRegistry;
    restart: () => Promise<void>;
    reverse: ConnectionModule;
    processSubscriptions?: ProcessSubscriptionManager;
    shutdown: () => Promise<void>;
    socketPath: string;
    web: ControlWebRuntime;
}

export class ControlRuntime {
    readonly #instanceRuntimes: InstanceRuntimeRegistry;
    readonly #toolCallRuntime: ToolCallRuntime;
    readonly #contexts: ContextRuntime;
    readonly #artifact: ArtifactRuntime;
    readonly #builtinExtensionSources: readonly BuiltinExtensionSource[];
    readonly #transport: ControlTransportServer;
    readonly #debug: DebugRuntime;
    readonly #extensionControl: ExtensionControlService;
    readonly #extensionPaths: ExtensionPathLayout;
    readonly #extensions: ExtensionRuntime;
    readonly #instances: InstanceRegistry;
    readonly #internalControlEndpoint: Endpoint;
    readonly #internalControlServer: ServerTransport;
    readonly #instanceEditor: InstanceEditorCoordinator;
    readonly #mcp: McpControlModule;
    readonly #reverse: ConnectionModule;
    readonly #routes: ControlRouteRegistry;
    readonly #socketListener: ControlSocketListener;
    readonly #toolCallHookUnregister: Array<() => void>;
    readonly #toolCallRegistryUnbind: () => void;
    readonly #toolCalls: ToolCallApi;
    readonly #web: ControlWebRuntime;

    constructor(options: ControlRuntimeOptions) {
        this.#instanceRuntimes = options.instanceRuntimes;
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
        const runtimeFor = (name: string) => {
            const descriptor = options.instances.get(name);
            if (descriptor === undefined) throw new Error(`Instance ${name} is unavailable.`);
            return options.instanceRuntimes.get(descriptor);
        };
        const toolCalls = createToolCallRuntime({
            resolveTarget: (name) => runtimeFor(name).target(),
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
            registerApprovalToolCallReview(options.toolCalls, (name) => runtimeFor(name).approval.api),
            installTodoTools(options.toolCalls, (name) => runtimeFor(name).task.api),
            installWaitToolCallRewrite(options.toolCalls, (name) => runtimeFor(name).task.api.wait),
        ];
        this.#mcp = options.mcp;
        this.#mcp.setToolCalls(this.#toolCalls);
        const extensionMcpTools = new McpExtensionService(this.#extensions);
        this.#toolCallHookUnregister.push(
            extensionMcpTools.install(options.toolCalls),
        );
        this.#reverse = options.reverse;
        this.#debug = createDebugRuntime({
            instances: options.instances,
            target: (descriptor) => options.instanceRuntimes.get(descriptor),
        });
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
            installContextTools(options.contexts.api, options.toolCalls, {
                instances: options.instances,
                modelCommands,
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
            instancePorts: (descriptor, sessions) => {
                const runtime = options.instanceRuntimes.get(descriptor);
                const events = {
                    cursor: () => descriptor.worker.snapshot().lastSeq,
                    subscribe: (fromSeq?: number) => descriptor.worker.subscribe(fromSeq),
                };
                return [
                    createApprovalRouteModule({ approval: runtime.approval.api, events, name: descriptor.name }, processSubscriptions),
                    createTerminalRouteModule({ backend: runtime.terminal.api, instance: descriptor.name, sessions }),
                    createGoalTaskRouteModule({ events, goal: runtime.task.api.goal }),
                    createTodoTaskRouteModule({ events, name: descriptor.name, todo: runtime.task.api.todo }, processSubscriptions),
                    createToolRouteModule({
                        name: descriptor.name,
                        worker: {
                            readWorkerTools: async () => runtime.tools.listTools(),
                            prepareWorkspace: (workspace, connectionId) => runtime.openToolSession(workspace, connectionId),
                            readToolCalls: (query) => runtime.tools.readToolCalls(query),
                            releaseToolSession: (connectionId) => runtime.releaseToolSession(connectionId),
                            subscribe: events.subscribe,
                        },
                    }, options.mcp.toolProvenance, this.#toolCalls, processSubscriptions),
                ];
            },
            debug: this.#debug,
            extension: this.#extensionControl,
            extensionRoutes: new ControlExtensionRouteService(this.#extensions),
            instanceCreate: options.instanceCreate,
            instanceEditor: options.instanceEditor,
            instanceChanges: options.instanceChanges,
            instances: options.instances,
            mcpStatus: () => options.mcp.status(),
            oauthApprovals: () => options.mcp.oauthApprovals,
            overview: createOperationalOverviewRuntime({
                instanceCollector: new OperationalOverviewInstanceCollector({
                    activityLimit: 20,
                    instanceData: descriptor => {
                        const runtime = options.instanceRuntimes.get(descriptor);
                        return { approval: runtime.approval.api, task: runtime.task.api, tools: runtime.tools };
                    },
                }),
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
            this.#reverse.stop();
        } catch (error) {
            failures.push(error);
        }
        await this.#artifact.stop().catch((error) => failures.push(error));
        await stopOwnedInstances(this.#instances).catch((error) =>
            failures.push(error),
        );
        await this.#instanceRuntimes.close().catch((error) => failures.push(error));
        this.#toolCallRuntime.close();
        this.#contexts.close();
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

async function stopOwnedInstances(
    instances: InstanceRegistry,
): Promise<void> {
    const failures: Error[] = [];
    const ownedWorkers = new Map<WorkerInstance, string>();
    for (const instance of instances.list()) {
        for (const worker of instance.ownedWorkers())
            ownedWorkers.set(worker, instance.name);
    }
    for (const [worker, name] of ownedWorkers) {
        try {
            await worker.stop();
            instances.get(name)?.clearOwnedWorker(worker);
        } catch (error) {
            failures.push(
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(
            failures,
            `Failed to stop ${failures.length} worker instance(s).`,
        );
    }
}
