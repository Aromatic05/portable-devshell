import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import {
    asInstanceName,
    PrefixRoute,
    type JsonValue,
    type PrefixRouteDestinationDefinition,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";

import type { ArtifactService } from "../control/artifact/Service.js";
import { createArtifactRouteModule } from "../control/artifact/route/Module.js";
import { createCliRouteModule, type CliCommandPort } from "../control/extension/cli/Route.js";
import type { ConfigEditorPort } from "../control/config/Route.js";
import { createConfigRouteModule } from "../control/config/Route.js";
import {
    createConversationPreferenceRouteModule,
    type ConversationPreferencePort,
} from "../control/config/preference/Route.js";
import { createDebugRouteModule, type DebugPatchPort } from "../control/debug/Route.js";
import { createExtensionRouteModule, type ExtensionControlPort } from "../control/extension/Route.js";
import type { InstanceCreatePort } from "../control/instance/Route.js";
import { createInstanceRouteModule } from "../control/instance/Route.js";
import type { InstanceRegistry } from "../control/instance/registry/Registry.js";
import { createContextRouteModule, type ContextAdminPort } from "./mcp/route/Context.js";
import { createMcpRouteModule } from "./mcp/route/Module.js";
import type { OperationalOverviewPort } from "../control/overview/Route.js";
import { createOperationalOverviewRouteModule } from "../control/overview/Route.js";
import { OperationalOverviewService } from "../control/overview/Service.js";
import type { ReverseCredentialService } from "../control/reverse/credential/Service.js";
import { createReverseRouteModule } from "../control/reverse/Route.js";
import type { ToolCallProvenanceStore } from "../instance/execution/tool/Provenance.js";
import { createContextMessageRouteModule } from "../instance/context/Route.js";
import { createConversationRouteModule } from "../instance/conversation/Route.js";
import { createGoalRouteModule } from "../instance/workflow/goal/Route.js";
import { createRuntimeRouteModule } from "../instance/execution/runtime/Route.js";
import { RuntimeSubscriptionManager } from "../instance/execution/runtime/Subscription.js";
import { createServiceRouteModule } from "../server/endpoint/Channel.js";
import { createTodoRouteModule } from "../instance/workflow/todo/Route.js";
import { createTerminalRouteModule } from "../instance/execution/terminal/Route.js";
import type { TerminalBackend } from "../instance/execution/terminal/Backend.js";
import { TerminalSessionService } from "../instance/execution/terminal/Service.js";
import { createToolRouteModule } from "../instance/execution/tool/Route.js";
import {
    createWebApplicationRouteModule,
    type WebApplicationCatalogPort
} from "../server/web/extension/application/Route.js";

export interface ControlRouteCompositionOptions {
    artifact?: ArtifactService;
    cliCommands?: CliCommandPort;
    config?: ConfigEditorPort;
    contextAdmin?: () => ContextAdminPort | undefined;
    conversationPreferences?: ConversationPreferencePort;
    debug?: DebugPatchPort;
    extension?: ExtensionControlPort;
    instanceCreate?: InstanceCreatePort;
    instances: InstanceRegistry;
    mcpStatus?: () => JsonValue;
    oauthApprovals?: () => McpOAuthApprovalService | undefined;
    overview?: OperationalOverviewPort;
    restart?: () => Promise<void> | void;
    reverse?: ReverseCredentialService;
    runtimeSubscriptions?: RuntimeSubscriptionManager;
    shutdown(): Promise<void> | void;
    terminalMaxUnackedBytes?: number;
    toolProvenance?: ToolCallProvenanceStore;
    webApplications?: WebApplicationCatalogPort;
}

export class ControlRouteComposition {
    readonly #overview: OperationalOverviewPort;
    readonly #options: ControlRouteCompositionOptions;
    readonly #subscriptions: RuntimeSubscriptionManager;
    readonly #terminalBackends = new Map<string, TerminalBackend>();
    readonly #terminals = new TerminalSessionService();
    readonly #unsubscribeInstances: () => void;
    #snapshot: PrefixRouteSnapshot;

    constructor(options: ControlRouteCompositionOptions) {
        this.#options = options;
        this.#subscriptions = options.runtimeSubscriptions ?? new RuntimeSubscriptionManager();
        this.#overview = options.overview ?? new OperationalOverviewService({
            instances: options.instances,
            oauthApprovals: options.oauthApprovals
        });
        this.#snapshot = this.#build();
        this.#unsubscribeInstances = options.instances.onChange(() => {
            this.#snapshot = this.#build();
        });
    }

    snapshot(): PrefixRouteSnapshot {
        return this.#snapshot;
    }

    connectionClosed(connectionId: string): void {
        this.#subscriptions.unsubscribeConnection(connectionId);
    }

    async retireInstance(instance: string): Promise<void> {
        await this.#terminals.closeInstance(instance);
    }

    dispose(): void {
        this.#unsubscribeInstances();
        this.#terminals.close();
    }

    #build(): PrefixRouteSnapshot {
        const descriptors = this.#options.instances.list();
        const nextTerminalBackends = new Map<string, TerminalBackend>();
        const definitions: PrefixRouteDestinationDefinition[] = [
            {
                destination: "@control",
                modules: [
                    createServiceRouteModule({
                        instanceCount: () => this.#options.instances.list().length,
                        restart: this.#options.restart,
                        shutdown: this.#options.shutdown
                    }),
                    ...(this.#options.debug === undefined
                        ? []
                        : [createDebugRouteModule(this.#options.debug)]),
                    ...(this.#options.extension === undefined
                        ? []
                        : [createExtensionRouteModule(this.#options.extension)]),
                    ...(this.#options.cliCommands === undefined
                        ? []
                        : [createCliRouteModule(this.#options.cliCommands)]),
                    ...(this.#options.webApplications === undefined
                        ? []
                        : [createWebApplicationRouteModule(this.#options.webApplications)]),
                    createMcpRouteModule({
                        approvals: this.#options.oauthApprovals ?? (() => undefined),
                        status: this.#options.mcpStatus ?? (() => ({
                            running: false,
                            reason: "MCP runtime is disabled."
                        }))
                    }),
                    createContextRouteModule(this.#options.contextAdmin),
                    ...(this.#options.conversationPreferences === undefined
                        ? []
                        : [createConversationPreferenceRouteModule(this.#options.conversationPreferences)]),
                    createOperationalOverviewRouteModule(this.#overview),
                    createInstanceRouteModule({
                        create: this.#options.instanceCreate,
                        editor: this.#options.config,
                        registry: this.#options.instances
                    }),
                    createConfigRouteModule(this.#options.config),
                    createReverseRouteModule(this.#options.reverse),
                    createArtifactRouteModule(this.#options.artifact)
                ]
            }
        ];

        for (const descriptor of descriptors) {
            if (descriptor.terminal !== undefined) {
                nextTerminalBackends.set(descriptor.name, descriptor.terminal);
            }
            definitions.push({
                destination: asInstanceName(descriptor.name),
                modules: [
                    createRuntimeRouteModule(
                        {
                            enabled: descriptor.enabled,
                            name: descriptor.name,
                            todoSummaries: () => descriptor.todo.summaries(),
                            worker: descriptor.worker
                        },
                        this.#options.instances,
                        this.#subscriptions
                    ),
                    ...(descriptor.contextMessages === undefined ? [] : [createContextMessageRouteModule(
                        descriptor.contextMessages
                    )]),
                    createConversationRouteModule(descriptor.conversation),
                    createGoalRouteModule(descriptor),
                    createTodoRouteModule(descriptor, this.#subscriptions),
                    createToolRouteModule(descriptor, this.#options.toolProvenance),
                    ...(descriptor.terminal === undefined ? [] : [createTerminalRouteModule({
                        backend: descriptor.terminal,
                        instance: descriptor.name,
                        ...(this.#options.terminalMaxUnackedBytes === undefined
                            ? {}
                            : { maxUnackedBytes: this.#options.terminalMaxUnackedBytes }),
                        sessions: this.#terminals
                    })])
                ]
            });
        }

        for (const [name, backend] of this.#terminalBackends) {
            if (nextTerminalBackends.get(name) === backend) continue;
            void this.#terminals.closeInstance(name).catch((error: unknown) => {
                console.warn(
                    error instanceof Error ? error : new Error(String(error)),
                );
            });
        }
        this.#terminalBackends.clear();
        for (const [name, backend] of nextTerminalBackends) {
            this.#terminalBackends.set(name, backend);
        }

        return PrefixRoute.snapshot(definitions);
    }
}
