import type { WorkerInstance, WorkerRpcInboundConnector } from "@portable-devshell/core";
import type { TerminalBackend } from "../terminal/TerminalProcess.js";
import type { ContextMessageQueueInput, ContextMessageReadResult, ContextMessageRecord } from "@portable-devshell/shared";
import type {
    ActiveTodoSummary,
    JsonValue,
    TodoReadInput,
    TodoReadResult,
    TodoTaskControlAction,
    TodoWriteInput,
    ToolCallAssociation,
    ToolCapability,
    WaitCreateInput,
    WaitRecord
} from "@portable-devshell/shared";

export interface InstanceContextMessagePort {
    list(ctxId?: string): Promise<ContextMessageRecord[]>;
    queue(input: ContextMessageQueueInput): Promise<ContextMessageRecord>;
    consumePending(ctxId: string, callId: string): Promise<ContextMessageReadResult>;
}

export interface InstanceTodoPort {
    control(taskId: string, action: TodoTaskControlAction, ctxId: string): Promise<TodoReadResult>;
    currentAssociation(): ToolCallAssociation | undefined;
    delete(taskId: string): Promise<void>;
    read(input?: TodoReadInput): Promise<TodoReadResult>;
    summaries(): ActiveTodoSummary[];
    write(input: TodoWriteInput, ctxId: string): Promise<TodoReadResult>;
}

export interface InstanceWaitPort {
    cancel(waitId: string): Promise<WaitRecord>;
    claimRecovery(waitId: string, claimId: string): Promise<WaitRecord>;
    completeRecovery(waitId: string, claimId: string): Promise<WaitRecord>;
    consume(waitId: string): Promise<WaitRecord>;
    create(input: WaitCreateInput): Promise<WaitRecord>;
    detach(waitId: string): Promise<WaitRecord>;
    get(waitId: string): Promise<WaitRecord | undefined>;
    list(taskId?: string): Promise<WaitRecord[]>;
    reattach(waitId: string, ownerCallId?: string): Promise<WaitRecord>;
    releaseRecovery(waitId: string, claimId: string): Promise<WaitRecord>;
    resolve(waitId: string, result?: JsonValue): Promise<WaitRecord>;
    waitForResolution(waitId: string): Promise<WaitRecord>;
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
    terminal?: TerminalBackend;
    todo: InstanceTodoPort;
    wait?: InstanceWaitPort;
    worker: WorkerInstance;
}
