import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import {
    asInstanceName,
    type ControlHostDefinition,
    type ControlPortDefinition,
    type JsonValue,
} from "@portable-devshell/shared";

import type { ArtifactService } from "../control/artifact/Service.js";
import { createArtifactRouteModule } from "../control/artifact/route/Module.js";
import {
    createCliRouteModule,
    type CliCommandPort,
} from "../control/extension/cli/Route.js";
import {
    createTuiPageRouteModule,
    type TuiPagePort,
} from "../control/extension/tui/Route.js";
import type { ConfigEditorPort } from "../control/config/Route.js";
import { createConfigRouteModule } from "../control/config/Route.js";
import {
    createDebugRouteModule,
    type DebugPatchPort,
} from "../control/debug/Route.js";
import {
    createExtensionRouteModule,
    type ExtensionControlPort,
} from "../control/extension/Route.js";
import type { InstanceCreatePort } from "../control/instance/Route.js";
import {
    createInstanceRouteModule,
    type InstanceRouteModuleOptions,
} from "../control/instance/Route.js";
import type { InstanceRegistry } from "../control/instance/registry/Registry.js";
import {
    createContextRouteModule,
    type ContextAdminPort,
} from "../control/context/Route.js";
import { createMcpRouteModule } from "./mcp/route/Module.js";
import type { OperationalOverviewPort } from "../control/overview/Route.js";
import { createOperationalOverviewRouteModule } from "../control/overview/Route.js";
import { OperationalOverviewService } from "../control/overview/Service.js";
import type { ReverseCredentialService } from "../control/reverse/credential/Service.js";
import { createReverseRouteModule } from "../control/reverse/Route.js";
import type { ToolCallProvenanceStore } from "../instance/execution/tool/Provenance.js";
import { createApprovalRouteModule } from "../control/approval/Route.js";
import { createGoalRouteModule } from "../instance/workflow/goal/Route.js";
import { createRuntimeRouteModule } from "../instance/execution/runtime/Route.js";
import { RuntimeSubscriptionManager } from "../instance/execution/runtime/Subscription.js";
import { createServiceRouteModule } from "../server/endpoint/Channel.js";
import { createTodoRouteModule } from "../instance/workflow/todo/Route.js";
import { createTerminalRouteModule } from "../instance/execution/terminal/Route.js";
import { TerminalSessionService } from "../instance/execution/terminal/Service.js";
import {
    createControlToolRouteModule,
    createToolRouteModule,
    type ToolCallIngressPort,
} from "../instance/execution/tool/Route.js";
import {
    createWebApplicationRouteModule,
    type WebApplicationCatalogPort,
    type WebPagePort,
} from "../server/web/extension/application/Route.js";

export interface ControlRouteExtensionPort {
    modules(scope: "control" | "instance"): readonly ControlPortDefinition[];
    onChange(listener: () => void): () => void;
}

export interface ControlRouteCompositionOptions {
    artifact?: ArtifactService;
    cliCommands?: CliCommandPort;
    config?: ConfigEditorPort;
    contextAdmin?: () => ContextAdminPort | undefined;
    debug?: DebugPatchPort;
    extension?: ExtensionControlPort;
    extensionRoutes?: ControlRouteExtensionPort;
    instanceCreate?: InstanceCreatePort;
    configuredInstances?: InstanceRouteModuleOptions["configuredInstances"];
    instances: InstanceRegistry;
    mcpStatus?: () => JsonValue;
    oauthApprovals?: () => McpOAuthApprovalService | undefined;
    overview?: OperationalOverviewPort;
    restart?: () => Promise<void> | void;
    reverse?: ReverseCredentialService;
    runtimeSubscriptions?: RuntimeSubscriptionManager;
    shutdown(): Promise<void> | void;
    terminalMaxUnackedBytes?: number;
    toolCalls?: ToolCallIngressPort;
    toolProvenance?: ToolCallProvenanceStore;
    tuiPages?: TuiPagePort;
    webApplications?: WebApplicationCatalogPort;
    webPages?: WebPagePort;
}

export class ControlRouteComposition {
    readonly #overview: OperationalOverviewPort;
    readonly #options: ControlRouteCompositionOptions;
    readonly #subscriptions: RuntimeSubscriptionManager;
    readonly #terminals = new TerminalSessionService();
    readonly #unsubscribeExtensions: () => void;
    readonly #unsubscribeInstances: () => void;
    readonly #listeners = new Set<() => void>();
    #hosts: readonly ControlHostDefinition[];

    constructor(options: ControlRouteCompositionOptions) {
        this.#options = options;
        this.#subscriptions =
            options.runtimeSubscriptions ?? new RuntimeSubscriptionManager();
        this.#overview =
            options.overview ??
            new OperationalOverviewService({
                instances: options.instances,
                oauthApprovals: options.oauthApprovals,
            });
        this.#hosts = this.#build();
        this.#unsubscribeExtensions =
            options.extensionRoutes?.onChange(() => this.#rebuild()) ??
            (() => undefined);
        this.#unsubscribeInstances = options.instances.onChange(() =>
            this.#rebuild(),
        );
    }

    hosts(): readonly ControlHostDefinition[] {
        return this.#hosts;
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    connectionClosed(connectionId: string): void {
        this.#subscriptions.unsubscribeConnection(connectionId);
    }

    async retireInstance(instance: string): Promise<void> {
        await this.#terminals.closeInstance(instance);
    }

    dispose(): void {
        this.#unsubscribeExtensions();
        this.#unsubscribeInstances();
        this.#terminals.close();
    }

    #rebuild(): void {
        this.#hosts = this.#build();
        for (const listener of this.#listeners) listener();
    }

    #build(): readonly ControlHostDefinition[] {
        const descriptors = this.#options.instances.list();
        const definitions: ControlHostDefinition[] = [
            {
                host: "@control",
                ports: [
                    createServiceRouteModule({
                        instanceCount: () =>
                            this.#options.instances.list().length,
                        restart: this.#options.restart,
                        shutdown: this.#options.shutdown,
                    }),
                    ...(this.#options.debug === undefined
                        ? []
                        : [createDebugRouteModule(this.#options.debug)]),
                    ...(this.#options.extension === undefined
                        ? []
                        : [
                              createExtensionRouteModule(
                                  this.#options.extension,
                              ),
                          ]),
                    ...(this.#options.cliCommands === undefined
                        ? []
                        : [createCliRouteModule(this.#options.cliCommands)]),
                    ...(this.#options.tuiPages === undefined
                        ? []
                        : [createTuiPageRouteModule(this.#options.tuiPages)]),
                    ...(this.#options.webApplications === undefined
                        ? []
                        : [
                              createWebApplicationRouteModule(
                                  this.#options.webApplications,
                                  this.#options.webPages,
                              ),
                          ]),
                    createMcpRouteModule({
                        approvals:
                            this.#options.oauthApprovals ?? (() => undefined),
                        status:
                            this.#options.mcpStatus ??
                            (() => ({
                                running: false,
                                reason: "MCP runtime is disabled.",
                            })),
                    }),
                    createContextRouteModule(this.#options.contextAdmin),
                    ...(this.#options.toolCalls === undefined
                        ? []
                        : [createControlToolRouteModule(this.#options.toolCalls)]),
                    ...(this.#options.extensionRoutes?.modules("control") ?? []),
                    createOperationalOverviewRouteModule(this.#overview),
                    createInstanceRouteModule({
                        configuredInstances: this.#options.configuredInstances,
                        create: this.#options.instanceCreate,
                        editor: this.#options.config,
                        registry: this.#options.instances,
                    }),
                    createConfigRouteModule(this.#options.config),
                    createReverseRouteModule(this.#options.reverse),
                    createArtifactRouteModule(this.#options.artifact),
                ],
            },
        ];

        for (const descriptor of descriptors) {
            const modules: ControlPortDefinition[] = [
                createRuntimeRouteModule(
                    {
                        enabled: descriptor.enabled,
                        name: descriptor.name,
                        todoSummaries: () => descriptor.todo.summaries(),
                        worker: descriptor.worker,
                    },
                    this.#options.instances,
                    this.#subscriptions,
                ),
                ...(this.#options.extensionRoutes?.modules("instance") ?? []),
                createGoalRouteModule(descriptor),
                createTodoRouteModule(descriptor, this.#subscriptions),
                createApprovalRouteModule(descriptor),
                createToolRouteModule(
                    descriptor,
                    this.#options.toolProvenance,
                ),
                ...(descriptor.terminal === undefined
                    ? []
                    : [
                          createTerminalRouteModule({
                              backend: descriptor.terminal,
                              instance: descriptor.name,
                              ...(this.#options.terminalMaxUnackedBytes ===
                              undefined
                                  ? {}
                                  : {
                                        maxUnackedBytes:
                                            this.#options
                                                .terminalMaxUnackedBytes,
                                    }),
                              sessions: this.#terminals,
                          }),
                      ]),
            ];
            definitions.push({
                host: asInstanceName(descriptor.name),
                ports: fenceInstanceGeneration(
                    modules,
                    this.#options.instances,
                    descriptor,
                ),
            });
        }

        return definitions;
    }
}

function fenceInstanceGeneration(
    modules: readonly ControlPortDefinition[],
    registry: InstanceRegistry,
    descriptor: NonNullable<ReturnType<InstanceRegistry["get"]>>,
): ControlPortDefinition[] {
    return modules.map((module) => ({
        ...module,
        operations: module.operations.map((operation) => ({
            ...operation,
            handle: async (request, context) => {
                const generation = registry.acquireGeneration(
                    descriptor.name,
                    descriptor,
                );
                try {
                    return await operation.handle(request, context);
                } finally {
                    generation.release();
                }
            },
        })),
        ...(module.streams === undefined
            ? {}
            : {
                  streams: module.streams.map((operation) => ({
                      ...operation,
                      handle: async (stream, request, context) => {
                          const generation = registry.acquireGeneration(
                              descriptor.name,
                              descriptor,
                          );
                          try {
                              return await operation.handle(
                                  stream,
                                  request,
                                  context,
                              );
                          } finally {
                              generation.release();
                          }
                      },
                  })),
              }),
    }));
}
