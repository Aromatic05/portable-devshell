import type { WorkerInstance } from "@portable-devshell/core";

export interface InstanceDescriptor {
    allowTools: readonly string[];
    mcpEnabled: boolean;
    mcpPath: string;
    name: string;
    worker: WorkerInstance;
}
