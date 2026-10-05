import type { InstanceRegistry } from "../instance/Registry.js";
import { ContextService } from "./service/index.js";
import { ContextRegistry } from "./registry/index.js";
import { ContextEnvironmentService } from "./service/Scope.js";
import { ContextCleanupService } from "./service/Cleanup.js";

export class ContextModule extends ContextService {
    constructor(options: { contextFile: string; instances: InstanceRegistry }) {
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
        super({
            cleanup,
            environment,
            instances: options.instances,
            registry,
        });
    }
}
