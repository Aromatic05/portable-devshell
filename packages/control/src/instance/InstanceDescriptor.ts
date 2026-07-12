import type { WorkerInstance } from "@portable-devshell/core";
import type { ToolAccess } from "@portable-devshell/shared";
import type { TodoService } from "../todo/TodoService.js";

export interface InstanceDescriptor {
    enabled: boolean;
    mcpCapabilities: readonly ToolAccess[];
    mcpEnabled: boolean;
    mcpGroups: readonly string[];
    mcpPath: string;
    name: string;
    todo: TodoService;
    worker: WorkerInstance;
}
