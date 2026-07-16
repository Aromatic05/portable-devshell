import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import {
    asInstanceName,
    PrefixRoute,
    type JsonValue,
    type PrefixRouteDestinationDefinition,
    type PrefixRouteSnapshot
} from "@portable-devshell/shared";

import type { ArtifactService } from "../modules/artifact/ArtifactService.js";
import { createArtifactModule } from "../modules/artifact/ArtifactModule.js";
import type { ConfigEditorPort } from "../modules/config/ConfigModule.js";
import { createConfigModule } from "../modules/config/ConfigModule.js";
import type { InstanceCreatePort } from "../modules/instance/InstanceModule.js";
import { createInstanceModule } from "../modules/instance/InstanceModule.js";
import type { InstanceRegistry } from "../modules/instance/registry/InstanceRegistry.js";
import { createMcpModule } from "../modules/mcp/McpModule.js";
import type { ReverseControlService } from "../modules/reverse/ReverseControlService.js";
import { createReverseModule } from "../modules/reverse/ReverseModule.js";
import { createRuntimeModule } from "../modules/runtime/RuntimeModule.js";
import { RuntimeSubscriptionManager } from "../modules/runtime/RuntimeSubscriptionManager.js";
import { createServiceModule } from "../modules/service/ServiceModule.js";
import { createTodoModule } from "../modules/todo/TodoModule.js";
import { createToolModule } from "../modules/tool/ToolModule.js";

export interface RouteCompositionOptions {
    artifact?: ArtifactService;
    config?: ConfigEditorPort;
    instanceCreate?: InstanceCreatePort;
    instances: InstanceRegistry;
    mcpStatus?: () => JsonValue;
    oauthApprovals?: () => McpOAuthApprovalService | undefined;
    restart?: () => Promise<void> | void;
    reverse?: ReverseControlService;
    shutdown(): Promise<void> | void;
}

export class RouteComposition {
    readonly #options: RouteCompositionOptions;
    readonly #subscriptions = new RuntimeSubscriptionManager();
    readonly #unsubscribeInstances: () => void;
    #snapshot: PrefixRouteSnapshot;

    constructor(options: RouteCompositionOptions) {
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
                    createServiceModule({
                        instanceCount: () => this.#options.instances.list().length,
                        restart: this.#options.restart,
                        shutdown: this.#options.shutdown
                    }),
                    createMcpModule({
                        approvals: this.#options.oauthApprovals ?? (() => undefined),
                        status: this.#options.mcpStatus ?? (() => ({
                            running: false,
                            reason: "MCP runtime is disabled."
                        }))
                    }),
                    createInstanceModule({
                        create: this.#options.instanceCreate,
                        editor: this.#options.config,
                        registry: this.#options.instances
                    }),
                    createConfigModule(this.#options.config),
                    createReverseModule(this.#options.reverse),
                    createArtifactModule(this.#options.artifact)
                ]
            }
        ];

        for (const descriptor of this.#options.instances.list()) {
            definitions.push({
                destination: asInstanceName(descriptor.name),
                modules: [
                    createRuntimeModule(
                        {
                            enabled: descriptor.enabled,
                            name: descriptor.name,
                            todoSummary: () => descriptor.todo.summary(),
                            worker: descriptor.worker
                        },
                        this.#options.instances,
                        this.#subscriptions
                    ),
                    createTodoModule(descriptor, this.#subscriptions),
                    createToolModule(descriptor)
                ]
            });
        }

        return PrefixRoute.snapshot(definitions);
    }
}
