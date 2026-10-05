import {
    mergeControlPortsByName,
    type ControlHostDefinition,
    type ControlPortDefinition,
    JsonValue,
} from "@portable-devshell/shared";

import { negotiateControlProtocol } from "./Protocol.js";
import { routeModule } from "../Port.js";
import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import {
    createInstanceHost,
    createConnectionRouteModule,
    createToolIngressHost,
    InstanceRegistry,
    ProcessSubscriptionManager,
    TerminalSessionService,
    type ToolCallIngressPort,
    type ToolCallProvenanceStore,
} from "@portable-devshell/core";

import type { ArtifactRouteApi } from "../artifact/Api.js";
import { createArtifactRouteModule } from "../artifact/route/Module.js";
import {
    createCliRouteModule,
    type CliCommandPort,
} from "../extension/api/point/cli/Endpoint.js";
import {
    createTuiPageRouteModule,
    type TuiPagePort,
} from "../extension/api/point/tui/Endpoint.js";
import type { ConfigEditorPort } from "../config/Route.js";
import { createConfigRouteModule } from "../config/Route.js";
import { ConfigChangeHub } from "../config/change/Config.js";
import { createDebugRouteModule, type DebugPatchPort } from "../debug/Route.js";
import { createExtensionRouteModule } from "../extension/manager/Endpoint.js";
import type { ExtensionControlPort } from "../extension/manager/Port.js";
import type {
    InstanceCreatePort,
    InstanceEditorPort,
} from "../instance/Route.js";
import {
    createInstanceConfigRouteModule,
    type InstanceConfigRouteModuleOptions,
} from "../instance/Route.js";
import { InstanceChangeHub } from "../instance/Change.js";
import { createAuthRouteModule } from "../auth/Route.js";
import type { OperationalOverviewPort } from "../overview/Route.js";
import { createOperationalOverviewRouteModule } from "../overview/Route.js";
import { OperationalOverviewService } from "../overview/Service.js";
import type { ReverseCredentials } from "@portable-devshell/core";
import {
    createWebApplicationRouteModule,
    type WebApplicationCatalogPort,
    type WebPagePort,
} from "./web/extension/application/Route.js";

export interface ServerRouteModuleOptions {
    instanceCount(): number;
    restart?: () => Promise<void> | void;
    shutdown(): Promise<void> | void;
}

export function createServerRouteModule(
    options: ServerRouteModuleOptions,
): ControlPortDefinition {
    return routeModule("server", {
        hello: (request, context) =>
            negotiateControlProtocol(
                request.payload,
                context.peer,
            ) as unknown as JsonValue,
        ping: () => ({ pong: true }),
        status: () => ({
            instanceCount: options.instanceCount(),
            ok: true,
            pid: process.pid,
        }),
        shutdown: (_request, context) => {
            context.afterReply(options.shutdown);
            return { accepted: true };
        },
        restart: (_request, context) => {
            if (options.restart !== undefined)
                context.afterReply(options.restart);
            return { accepted: true };
        },
    });
}

export interface ControlRouteExtensionPort {
    modules(scope: "control" | "instance"): readonly ControlPortDefinition[];
    onChange(listener: () => void): () => void;
}

export interface ControlRouteRegistryOptions {
    artifact?: ArtifactRouteApi;
    cliCommands?: CliCommandPort;
    config?: ConfigEditorPort;
    configChanges?: ConfigChangeHub;
    controlPorts?: readonly ControlPortDefinition[];
    debug?: DebugPatchPort;
    extension?: ExtensionControlPort;
    extensionRoutes?: ControlRouteExtensionPort;
    instanceCreate?: InstanceCreatePort;
    instanceChanges?: InstanceChangeHub;
    instanceEditor?: InstanceEditorPort;
    configuredInstances?: InstanceConfigRouteModuleOptions["configuredInstances"];
    instances: InstanceRegistry;
    mcpStatus?: () => JsonValue;
    oauthApprovals?: () => McpOAuthApprovalService | undefined;
    overview?: OperationalOverviewPort;
    restart?: () => Promise<void> | void;
    reverse?: ReverseCredentials;
    processSubscriptions?: ProcessSubscriptionManager;
    shutdown(): Promise<void> | void;
    terminalMaxUnackedBytes?: number;
    toolCalls?: ToolCallIngressPort;
    toolProvenance?: ToolCallProvenanceStore;
    tuiPages?: TuiPagePort;
    webApplications?: WebApplicationCatalogPort;
    webPages?: WebPagePort;
}

export class ControlRouteRegistry {
    readonly #configChanges: ConfigChangeHub;
    readonly #overview: OperationalOverviewPort;
    readonly #instanceChanges: InstanceChangeHub;
    readonly #options: ControlRouteRegistryOptions;
    readonly #subscriptions: ProcessSubscriptionManager;
    readonly #terminals = new TerminalSessionService();
    readonly #unsubscribeExtensions: () => void;
    readonly #unsubscribeConfigChanges: () => void;
    readonly #unsubscribeInstances: () => void;
    readonly #listeners = new Set<() => void>();
    #hosts: readonly ControlHostDefinition[];

    constructor(options: ControlRouteRegistryOptions) {
        this.#options = options;
        this.#configChanges = options.configChanges ?? new ConfigChangeHub();
        this.#instanceChanges =
            options.instanceChanges ?? new InstanceChangeHub();
        this.#subscriptions =
            options.processSubscriptions ?? new ProcessSubscriptionManager();
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
        this.#unsubscribeConfigChanges = this.#configChanges.onChange(
            (change) => {
                if (
                    change.paths.some(
                        (path) =>
                            path === "instances" ||
                            path.startsWith("instances."),
                    )
                ) {
                    this.#instanceChanges.publish("config");
                }
            },
        );
        this.#unsubscribeInstances = this.#instanceChanges.onChange(() => {
            this.#rebuild();
        });
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
        await this.#options.extensionRoutes?.retireInstance(instance);
        await this.#terminals.closeInstance(instance);
    }

    dispose(): void {
        this.#unsubscribeExtensions();
        this.#unsubscribeConfigChanges();
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
                ports: mergeControlPortsByName([
                    createServerRouteModule({
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
                    createAuthRouteModule({
                        approvals:
                            this.#options.oauthApprovals ?? (() => undefined),
                        status:
                            this.#options.mcpStatus ??
                            (() => ({
                                running: false,
                                reason: "MCP runtime is disabled.",
                            })),
                    }),
                    routeModule("mcp", {
                        status: () =>
                            this.#options.mcpStatus?.() ?? {
                                running: false,
                                reason: "MCP runtime is disabled.",
                            },
                    }),
                    ...(this.#options.controlPorts ?? []),
                    ...(this.#options.extensionRoutes?.modules("control") ??
                        []),
                    createOperationalOverviewRouteModule(this.#overview),
                    createConfigRouteModule(
                        this.#options.config,
                        this.#configChanges,
                    ),
                    createInstanceConfigRouteModule({
                        changes: this.#instanceChanges,
                        configuredInstances: this.#options.configuredInstances,
                        create: this.#options.instanceCreate,
                        editor: this.#options.instanceEditor,
                        registry: this.#options.instances,
                    }),
                    createConnectionRouteModule(this.#options.reverse),
                    createArtifactRouteModule(this.#options.artifact),
                ]),
            },
        ];

        if (this.#options.toolCalls !== undefined) {
            definitions.push(createToolIngressHost(this.#options.toolCalls));
        }

        for (const descriptor of descriptors) {
            definitions.push(
                createInstanceHost({
                    descriptor,
                    extensionPorts:
                        this.#options.extensionRoutes?.modules("instance") ??
                        [],
                    registry: this.#options.instances,
                    subscriptions: this.#subscriptions,
                    terminalMaxUnackedBytes:
                        this.#options.terminalMaxUnackedBytes,
                    terminals: this.#terminals,
                }),
            );
        }

        return definitions;
    }
}
