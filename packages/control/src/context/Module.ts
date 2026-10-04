import { ContextService } from "./Service/index.js";
import { ContextRegistry } from "./Registry/index.js";
import { ContextEnvironmentService } from "./Service/Scope.js";
import { ContextCleanupService } from "./Service/Cleanup.js";
import type { InstanceRegistry } from "@portable-devshell/core";

export class ContextModule extends ContextService {
    constructor(options: { contextFile: string; instances: InstanceRegistry }) {
        const registry = new ContextRegistry({ filePath: options.contextFile });
        const cleanup = new ContextCleanupService({
            contextRegistry: registry,
        });
        const environment = new ContextEnvironmentService({
            contextRegistry: registry,
            cleanup,
        });
    }
}
