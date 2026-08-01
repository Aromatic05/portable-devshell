import type { WorkerInstance, WorkerRpcInboundConnector } from "@portable-devshell/core";
import type { ContextMessageQueueInput, ContextMessageReadResult, ContextMessageRecord } from "@portable-devshell/shared";
import type {
    ActiveTodoSummary,
    TodoReadResult,
    TodoWriteInput,
    ToolCallAssociation,
    ToolCapability
} from "@portable-devshell/shared";

export interface InstanceContextMessagePort {
    list(ctxId?: string): Promise<ContextMessageRecord[]>;
    queue(input: ContextMessageQueueInput): Promise<ContextMessageRecord>;
    readPending(ctxId: string): Promise<ContextMessageReadResult>;
}

export interface InstanceTodoPort {
    currentAssociation(): ToolCallAssociation | undefined;
    read(title?: string): Promise<TodoReadResult>;
    summaries(): ActiveTodoSummary[];
    write(input: TodoWriteInput, ctxId: string): Promise<TodoReadResult>;
}

export interface InstanceDescriptor {
    contextMessages?: InstanceContextMessagePort;
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
