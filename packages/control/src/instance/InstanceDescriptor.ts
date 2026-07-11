import type { WorkerInstance } from "@portable-devshell/core";
import type { ToolAccess } from "@portable-devshell/shared";

export interface InstanceDescriptor {
    enabled: boolean;
    mcpCapabilities: readonly ToolAccess[];
    mcpEnabled: boolean;
    mcpGroups: readonly string[];
    mcpPath: string;
    name: string;
    worker: WorkerInstance;
}
