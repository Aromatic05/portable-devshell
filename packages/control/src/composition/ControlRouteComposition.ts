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
import { createMcpRouteModule } from "../control/mcp/McpRouteModule.js";
import type { ReverseCredentialService } from "../control/reverse/credential/ReverseCredentialService.js";
import { createReverseRouteModule } from "../control/reverse/route/ReverseRouteModule.js";
import { createRuntimeRouteModule } from "../instance/runtime/RuntimeRouteModule.js";
import { RuntimeSubscriptionManager } from "../instance/runtime/RuntimeSubscriptionManager.js";
import { createServiceRouteModule } from "../control/service/ServiceRouteModule.js";
import { createTodoRouteModule } from "../instance/todo/TodoRouteModule.js";
import { createToolRouteModule } from "../instance/tool/ToolRouteModule.js";

export interface ControlRouteCompositionOptions {
    artifact?: ArtifactService;
    config?: ConfigEditorPort;
    instanceCreate?: InstanceCreatePort;
    instances: InstanceRegistry;
    mcpStatus?: () => JsonValue;
    oauthApprovals?: () => McpOAuthApprovalService | undefined;
    restart?: () => Promise<void> | void;
    reverse?: ReverseCredentialService;
    shutdown(): Promise<void> | void;
}

export class ControlRouteComposition {
    readonly #options: ControlRouteCompositionOptions;
    readonly #subscriptions = new RuntimeSubscriptionManager();
    readonly #unsubscribeInstances: () => void;
    #snapshot: PrefixRouteSnapshot;

    constructor(options: ControlRouteCompositionOptions) {
        this.#options = options;
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
    }

    #build(): PrefixRouteSnapshot {
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

        for (const descriptor of this.#options.instances.list()) {
            definitions.push({
                destination: asInstanceName(descriptor.name),
                modules: [
                    createRuntimeRouteModule(
                        {
                            enabled: descriptor.enabled,
                            name: descriptor.name,
                            todoSummary: () => descriptor.todo.summary(),
                            worker: descriptor.worker
                        },
                        this.#options.instances,
                        this.#subscriptions
                    ),
                    createTodoRouteModule(descriptor, this.#subscriptions),
                    createToolRouteModule(descriptor)
                ]
            });
        }

        return PrefixRoute.snapshot(definitions);
    }
}
