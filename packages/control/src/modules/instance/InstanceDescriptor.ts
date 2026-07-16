import type { WorkerInstance, WorkerRpcInboundConnector } from "@portable-devshell/core";
import type {
    ActiveTodoSummary,
    TodoReadResult,
    TodoWriteInput,
    ToolCallAssociation,
    ToolCapability
} from "@portable-devshell/shared";

export interface InstanceTodoPort {
    currentAssociation(): ToolCallAssociation | undefined;
    read(): Promise<TodoReadResult>;
    summary(): ActiveTodoSummary | undefined;
    write(input: TodoWriteInput, ctxId: string): Promise<TodoReadResult>;
}

export interface InstanceDescriptor {
    enabled: boolean;
    mcpCapabilities: readonly ToolCapability[];
    mcpEnabled: boolean;
    mcpGroups: readonly string[];
    mcpPath: string;
    name: string;
    provider: "docker" | "local" | "podman" | "reverse" | "ssh";
    reverseConnector?: WorkerRpcInboundConnector;
    todo: InstanceTodoPort;
    worker: WorkerInstance;
    workspace?: string;
}
