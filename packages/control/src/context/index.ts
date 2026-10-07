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
        environment: options.environment,
        runtime: options.runtime,
    });
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        environment: options.environment,
        leaseInstance: options.leaseInstance,
        runtime: options.runtime,
    });
    const service = new ContextService({
        cleanup,
        environment,
        environmentTransport: options.environment,
        leaseInstance: options.leaseInstance,
        process: options.process,
        registry,
    });
    return {
        api: service,
        initialize: async () => await service.initialize(),
        reconcile: async () => await service.reconcile(),
        close: () => {},
    };
}
