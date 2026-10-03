import type { McpInstanceGateway } from "@portable-devshell/mcp";
import { ContextService } from "./Service/index.js";
import { ContextRegistry } from "./Registry/index.js";
import { ContextEnvironmentService } from "./Service/Scope.js";
import { ContextCleanupService } from "./Service/Cleanup.js";
import type { InstanceRegistry } from "@portable-devshell/core";

export class ContextModule extends ContextService {
    readonly #gatewayHolder: { value?: McpInstanceGateway };

    constructor(options: { contextFile: string; instances: InstanceRegistry }) {
        const registry = new ContextRegistry({ filePath: options.contextFile });
        const gatewayHolder: { value?: McpInstanceGateway } = {};
        const gateway = () => gatewayHolder.value;
        const worker = (instance: string) =>
            options.instances.get(instance)?.worker;
        const cleanup = new ContextCleanupService({
            contextRegistry: registry,
            gateway,
            releaseLocalAlerts: async (instance, workspace) => {
                const target = worker(instance);
                if (target === undefined)
                    throw new Error(
                        "Instance " +
                            instance +
                            " is unavailable for Context cleanup.",
                    );
                await target.releaseAlerts(workspace);
            },
        });
        const environment = new ContextEnvironmentService({
            contextRegistry: registry,
            cleanup,
            gateway,
            worker,
        });
        super({ registry, environment, cleanup, gateway, worker });
        this.#gatewayHolder = gatewayHolder;
    }

    bindGateway(gateway: McpInstanceGateway): void {
        this.#gatewayHolder.value = gateway;
    }
}
