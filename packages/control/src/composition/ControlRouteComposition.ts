import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import {
    asInstanceName,
    PrefixRoute,
    type JsonValue,
    type PrefixRouteDestinationDefinition,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";

import type { ArtifactService } from "../control/artifact/ArtifactService.js";
import { createArtifactRouteModule } from "../control/artifact/route/ArtifactRouteModule.js";
import type { ConfigEditorPort } from "../control/config/ConfigRouteModule.js";
import { createConfigRouteModule } from "../control/config/ConfigRouteModule.js";
import type { InstanceCreatePort } from "../control/instance/InstanceRouteModule.js";
import { createInstanceRouteModule } from "../control/instance/InstanceRouteModule.js";
import type { InstanceRegistry } from "../control/instance/registry/InstanceRegistry.js";
import { createContextRouteModule, type ContextAdminPort } from "../control/mcp/ContextRouteModule.js";
import { createMcpRouteModule } from "../control/mcp/McpRouteModule.js";
import type { OperationalOverviewPort } from "../control/overview/OperationalOverviewRouteModule.js";
import { createOperationalOverviewRouteModule } from "../control/overview/OperationalOverviewRouteModule.js";
import { OperationalOverviewService } from "../control/overview/OperationalOverviewService.js";
import type { ReverseCredentialService } from "../control/reverse/credential/ReverseCredentialService.js";
import { createReverseRouteModule } from "../control/reverse/route/ReverseRouteModule.js";
import { createContextMessageRouteModule } from "../instance/context/ContextMessageRouteModule.js";
import { createRuntimeRouteModule } from "../instance/runtime/RuntimeRouteModule.js";
import { RuntimeSubscriptionManager } from "../instance/runtime/RuntimeSubscriptionManager.js";
import { createServiceRouteModule } from "../control/service/ServiceRouteModule.js";
import { createTodoRouteModule } from "../instance/todo/TodoRouteModule.js";
import { createTerminalRouteModule } from "../control/terminal/TerminalRouteModule.js";
import type { TerminalBackend } from "../control/terminal/TerminalProcess.js";
import { TerminalSessionService } from "../control/terminal/TerminalSessionService.js";
import { createToolRouteModule } from "../instance/tool/ToolRouteModule.js";

export interface ControlRouteCompositionOptions {
    artifact?: ArtifactService;
    config?: ConfigEditorPort;
    contextAdmin?: () => ContextAdminPort | undefined;
    instanceCreate?: InstanceCreatePort;
    instances: InstanceRegistry;
    mcpStatus?: () => JsonValue;
    oauthApprovals?: () => McpOAuthApprovalService | undefined;
    overview?: OperationalOverviewPort;
    restart?: () => Promise<void> | void;
    reverse?: ReverseCredentialService;
    shutdown(): Promise<void> | void;
    terminalMaxUnackedBytes?: number;
}

export class ControlRouteComposition {
    readonly #overview: OperationalOverviewPort;
    readonly #options: ControlRouteCompositionOptions;
    readonly #subscriptions = new RuntimeSubscriptionManager();
    readonly #terminalBackends = new Map<string, TerminalBackend>();
    readonly #terminals = new TerminalSessionService();
    readonly #unsubscribeInstances: () => void;
    #snapshot: PrefixRouteSnapshot;

    constructor(options: ControlRouteCompositionOptions) {
        this.#options = options;
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
                    createMcpRouteModule({
                        approvals: this.#options.oauthApprovals ?? (() => undefined),
                        status: this.#options.mcpStatus ?? (() => ({
                            running: false,
                            reason: "MCP runtime is disabled."
                        }))
                    }),
                    createContextRouteModule(this.#options.contextAdmin?.()),
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
                    ...(descriptor.contextMessages === undefined ? [] : [createContextMessageRouteModule(descriptor.contextMessages)]),
                    createTodoRouteModule(descriptor, this.#subscriptions),
                    createToolRouteModule(descriptor),
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
