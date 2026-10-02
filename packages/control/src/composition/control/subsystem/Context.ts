import type { McpInstanceGateway } from "@portable-devshell/mcp";
import { ContextService } from "../../../control/context/Service.js";
import { ContextRegistry } from "../../../control/context/Registry.js";
import { ContextEnvironmentService } from "../../../control/context/Environment.js";
import { ContextCleanupService } from "../../../control/context/Cleanup.js";
import type { InstanceRegistry } from "../../../control/instance/registry/Registry.js";

export class ControlRuntimeContext extends ContextService {
    readonly #gatewayHolder: { value?: McpInstanceGateway };

    constructor(options: { contextFile: string; instances: InstanceRegistry }) {
        const registry = new ContextRegistry({ filePath: options.contextFile });
        const gatewayHolder: { value?: McpInstanceGateway } = {};
        const gateway = () => gatewayHolder.value;
        const worker = (instance: string) => options.instances.get(instance)?.worker;
        const cleanup = new ContextCleanupService({
            contextRegistry: registry,
            gateway,
            releaseLocalAlerts: async (instance, workspace) => {
                const target = worker(instance);
                if (target === undefined) throw new Error(
                    "Instance " + instance + " is unavailable for Context cleanup.",
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

