import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import {
    createInstanceHost,
    createInstanceToolIngressHost,
    InstanceRegistry,
    ProcessSubscriptionManager,
    TerminalSessionService,
    type ToolCallIngressPort,
    type ToolCallProvenanceStore,
} from "@portable-devshell/core";
import type {
    ControlHostDefinition,
    ControlPortDefinition,
    JsonValue,
} from "@portable-devshell/shared";

import type { ArtifactService } from "../artifact/Service.js";
import { createArtifactRouteModule } from "../artifact/route/Module.js";
import {
    createCliRouteModule,
    type CliCommandPort,
} from "../extension/cli/Route.js";
import {
    createTuiPageRouteModule,
    type TuiPagePort,
} from "../extension/tui/Route.js";
import type { ConfigEditorPort } from "../config/Route.js";
import { createConfigRouteModule } from "../config/Route.js";
import { ConfigChangeHub } from "../config/Change.js";
import { createDebugRouteModule, type DebugPatchPort } from "../debug/Route.js";
import {
    createExtensionRouteModule,
    type ExtensionControlPort,
} from "../extension/Route.js";
import type { InstanceCreatePort } from "../config/instance/Route.js";
import {
    createInstanceConfigRouteModule,
    type InstanceConfigRouteModuleOptions,
} from "../config/instance/Route.js";
import { InstanceChangeHub } from "../config/instance/Change.js";
import {
    createContextRouteModule,
    type ContextAdminPort,
} from "../context/Route.js";
import { createAuthRouteModule } from "../auth/Route.js";
import type { OperationalOverviewPort } from "../overview/Route.js";
import { createOperationalOverviewRouteModule } from "../overview/Route.js";
import { OperationalOverviewService } from "../overview/Service.js";
import type { ReverseCredentialService } from "../connection/credential/Service.js";
import { createConnectionRouteModule } from "../connection/Route.js";
import { createServiceRouteModule } from "../service/Route.js";
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
    configChanges?: ConfigChangeHub;
    contextAdmin?: () => ContextAdminPort | undefined;
    debug?: DebugPatchPort;
    extension?: ExtensionControlPort;
    extensionRoutes?: ControlRouteExtensionPort;
    instanceCreate?: InstanceCreatePort;
    configuredInstances?: InstanceConfigRouteModuleOptions["configuredInstances"];
    instances: InstanceRegistry;
    mcpStatus?: () => JsonValue;
    oauthApprovals?: () => McpOAuthApprovalService | undefined;
    overview?: OperationalOverviewPort;
    restart?: () => Promise<void> | void;
    reverse?: ReverseCredentialService;
    processSubscriptions?: ProcessSubscriptionManager;
    shutdown(): Promise<void> | void;
    terminalMaxUnackedBytes?: number;
    toolCalls?: ToolCallIngressPort;
    toolProvenance?: ToolCallProvenanceStore;
    tuiPages?: TuiPagePort;
    webApplications?: WebApplicationCatalogPort;
    webPages?: WebPagePort;
}

export class ControlRouteComposition {
    readonly #configChanges: ConfigChangeHub;
    readonly #overview: OperationalOverviewPort;
    readonly #instanceChanges = new InstanceChangeHub();
    readonly #options: ControlRouteCompositionOptions;
    readonly #subscriptions: ProcessSubscriptionManager;
    readonly #terminals = new TerminalSessionService();
    readonly #unsubscribeExtensions: () => void;
    readonly #unsubscribeConfigChanges: () => void;
    readonly #unsubscribeInstances: () => void;
    readonly #listeners = new Set<() => void>();
    #hosts: readonly ControlHostDefinition[];

    constructor(options: ControlRouteCompositionOptions) {
        this.#options = options;
        this.#configChanges = options.configChanges ?? new ConfigChangeHub();
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
        this.#unsubscribeInstances = options.instances.onChange(() => {
            this.#instanceChanges.publish("registry");
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
                ports: mergePortDefinitionsByName([
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
                    createContextRouteModule(this.#options.contextAdmin),
                    ...(this.#options.extensionRoutes?.modules("control") ??
                        []),
                    createOperationalOverviewRouteModule(this.#overview),
                    mergePortDefinitions(
                        createConfigRouteModule(
                            this.#options.config,
                            this.#configChanges,
                        ),
                        createInstanceConfigRouteModule({
                            changes: this.#instanceChanges,
                            configuredInstances:
                                this.#options.configuredInstances,
                            create: this.#options.instanceCreate,
                            editor: this.#options.config,
                            registry: this.#options.instances,
                        }),
                    ),
                    createConnectionRouteModule(this.#options.reverse),
                    createArtifactRouteModule(this.#options.artifact),
                ]),
            },
        ];

        if (this.#options.toolCalls !== undefined) {
            definitions.push(
                createInstanceToolIngressHost(this.#options.toolCalls),
            );
        }

        for (const descriptor of descriptors) {
            definitions.push(
                createInstanceHost({
                    descriptor,
                    extensionModules:
                        this.#options.extensionRoutes?.modules("instance") ??
                        [],
                    registry: this.#options.instances,
                    subscriptions: this.#subscriptions,
                    terminalMaxUnackedBytes:
                        this.#options.terminalMaxUnackedBytes,
                    terminals: this.#terminals,
                    toolCalls: this.#options.toolCalls,
                    toolProvenance: this.#options.toolProvenance,
                }),
            );
        }

        return definitions;
    }
}

function mergePortDefinitions(
    ...definitions: readonly ControlPortDefinition[]
): ControlPortDefinition {
    const first = definitions[0];
    if (first === undefined)
        throw new Error("Cannot merge an empty port list.");
    if (definitions.some((definition) => definition.name !== first.name))
        throw new Error("Cannot merge ports with different names.");
    const operations = definitions.flatMap(
        (definition) => definition.operations,
    );
    const streams = definitions.flatMap(
        (definition) => definition.streams ?? [],
    );
    const names = new Set<string>();
    for (const operation of [...operations, ...streams]) {
        if (names.has(operation.name))
            throw new Error(
                `Duplicate ${first.name} operation: ${operation.name}`,
            );
        names.add(operation.name);
    }
    return {
        name: first.name,
        operations,
        ...(streams.length === 0 ? {} : { streams }),
    };
}

function mergePortDefinitionsByName(
    definitions: readonly ControlPortDefinition[],
): ControlPortDefinition[] {
    const groups = new Map<string, ControlPortDefinition[]>();
    for (const definition of definitions) {
        const group = groups.get(definition.name) ?? [];
        group.push(definition);
        groups.set(definition.name, group);
    }
    return [...groups.values()].map((group) => mergePortDefinitions(...group));
}
