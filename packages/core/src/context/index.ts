import type { ContextRuntimeOptions, ContextRuntime } from "./Api.js";


import { ContextService } from "./service/index.js";
import { ContextRegistry } from "./registry/index.js";
import { ContextEnvironmentService } from "./service/Scope.js";
import { ContextCleanupService } from "./service/Cleanup.js";





export function createContextRuntime(
    options: ContextRuntimeOptions,
): ContextRuntime {
    const registry = new ContextRegistry({ filePath: options.contextFile });
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        instances: options.instances,
    });
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        instances: options.instances,
    });
    const service = new ContextService({
        cleanup,
        environment,
        instances: options.instances,
        registry,
    });
    return {
        api: service,
        initialize: async () => await service.initialize(),
        reconcile: async () => await service.reconcile(),
        close: () => {},
    };
}
