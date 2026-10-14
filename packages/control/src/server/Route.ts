import type { InstanceRegistry } from "../instance/Api.js";
import { routeModule, mergeControlPortsByName, type ControlHostDefinition, type ControlPortDefinition, JsonValue, } from "@portable-devshell/shared";

import { negotiateControlProtocol } from "./Protocol.js";
import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import { createConnectionRouteModule } from "../instance/reverse/Route.js";


import type { ArtifactRouteApi } from "../artifact/Api.js";
import { createArtifactRouteModule } from "../artifact/route/index.js";
import {
    createCliRouteModule,
    type CliCommandPort,
} from "../extension/api/point/cli/Endpoint.js";
import {
    createTuiPageRouteModule,
    type TuiPagePort,
} from "../extension/api/point/tui/index.js";
import type { ConfigEditorPort } from "../config/Route.js";
import { createConfigRouteModule } from "../config/Route.js";
import { ConfigChangeHub } from "../config/change/Config.js";
import { createDebugRouteModule } from "../debug/Public.js";
import type { DebugApi } from "../debug/Api.js";
import { createExtensionRouteModule } from "../extension/manager/Endpoint.js";
import type { ExtensionControlPort } from "../extension/Api.js";
import type {
    InstanceCreatePort,
    InstanceEditorPort,
    InstanceConfigRouteModuleOptions,
} from "../instance/Api.js";
import {
    createInstanceConfigRouteModule,
} from "../instance/Public.js";
import { InstanceChangeHub } from "../instance/Change.js";
import { createAuthRouteModule } from "./auth/Route.js";
import { createOperationalOverviewRouteModule } from "../overview/Public.js";
import type { OperationalOverviewApi } from "../overview/Api.js";
import type { ReverseCredentials } from "../instance/reverse/Credentials.js";
import {
    createWebApplicationRouteModule,
    type WebApplicationCatalogPort,
    type WebPagePort,
} from "./web/extension/application/Route.js";

export interface ServerRouteModuleOptions {
    degradedServices?: () => readonly string[] | Promise<readonly string[]>;
    instanceCount(): number;
    ready(): boolean;
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
        status: async () => {
            const degradedServices = [...(await options.degradedServices?.() ?? [])];
            return {
                degraded: degradedServices.length > 0,
                degradedServices,
                instanceCount: options.instanceCount(),
                ok: true,
                pid: process.pid,
                ready: options.ready(),
            };
        },
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
    /**
     * Reports whether Control finished `startHosts` + `state.reconcile`.
     * Defaults to `true` for bare route registries; the running server
     * supplies its own lifecycle flag.
     */
    controlReady?: () => boolean;
    controlDegradedServices?: () => readonly string[] | Promise<readonly string[]>;
    debug?: DebugApi;
    extension?: ExtensionControlPort;
    extensionRoutes?: ControlRouteExtensionPort;
    instanceCreate?: InstanceCreatePort;
    instanceChanges?: InstanceChangeHub;
    instanceEditor?: InstanceEditorPort;
    configuredInstances?: InstanceConfigRouteModuleOptions["configuredInstances"];
    instances: InstanceRegistry;
    mcpStatus?: () => JsonValue;
    oauthApprovals?: () => McpOAuthApprovalService | undefined;
    overview: OperationalOverviewApi;
    restart?: () => Promise<void> | void;
    reverse?: ReverseCredentials;
    shutdown(): Promise<void> | void;
    tuiPages?: TuiPagePort;
    webApplications?: WebApplicationCatalogPort;
    webPages?: WebPagePort;
}

export class ControlRouteRegistry {
    readonly #configChanges: ConfigChangeHub;
    readonly #overview: OperationalOverviewApi;
    readonly #instanceChanges: InstanceChangeHub;
    readonly #options: ControlRouteRegistryOptions;
    readonly #unsubscribeExtensions: () => void;
    readonly #unsubscribeInstances: () => void;
    readonly #listeners = new Set<() => void>();
    #hosts: readonly ControlHostDefinition[];

    constructor(options: ControlRouteRegistryOptions) {
        this.#options = options;
        this.#configChanges = options.configChanges ?? new ConfigChangeHub();
        this.#instanceChanges =
            options.instanceChanges ?? new InstanceChangeHub();
        this.#overview = options.overview;
        this.#hosts = this.#build();
        this.#unsubscribeExtensions =
            options.extensionRoutes?.onChange(() => this.#rebuild()) ??
            (() => undefined);
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

    dispose(): void {
        this.#unsubscribeExtensions();
        this.#unsubscribeInstances();
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
                        degradedServices: this.#options.controlDegradedServices,
                        instanceCount: () =>
                            this.#options.instances.list().length,
                        ready: this.#options.controlReady ?? (() => true),
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

        for (const descriptor of descriptors) {
            definitions.push(
                descriptor.host(
                    this.#options.extensionRoutes?.modules("instance") ?? [],
                ),
            );
        }

        return definitions;
    }
}
