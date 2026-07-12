import type { WorkerInstance } from "@portable-devshell/core";
import type { ToolCapability } from "@portable-devshell/shared";
import type { TodoService } from "../todo/TodoService.js";

export interface InstanceDescriptor {
    enabled: boolean;
    mcpCapabilities: readonly ToolCapability[];
    mcpEnabled: boolean;
    mcpGroups: readonly string[];
    mcpPath: string;
    name: string;
    todo: TodoService;
    worker: WorkerInstance;
}
