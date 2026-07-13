import type { WorkerInstance, WorkerRpcInboundConnector } from "@portable-devshell/core";
import type { ToolCapability } from "@portable-devshell/shared";
import type { TodoService } from "../todo/TodoService.js";

export interface InstanceDescriptor {
    enabled: boolean;
    mcpCapabilities: readonly ToolCapability[];
    mcpEnabled: boolean;
    mcpGroups: readonly string[];
    mcpPath: string;
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnector?: WorkerRpcInboundConnector;
    todo: TodoService;
    worker: WorkerInstance;
    workspace?: string;
}
