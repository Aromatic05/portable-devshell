import type { WorkerInstance } from "@portable-devshell/core";

export interface InstanceDescriptor {
    allowTools: readonly string[];
    enabled: boolean;
    mcpEnabled: boolean;
    mcpPath: string;
    name: string;
    worker: WorkerInstance;
}
