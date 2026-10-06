import type { ApprovalRuntime } from "@portable-devshell/core/approval";
import type { AuditRuntime } from "@portable-devshell/core/audit";
import type {
    Instance,
    WorkerWorkspacePrepareResult,
} from "@portable-devshell/core/instance";
import type { TaskRuntime } from "@portable-devshell/core/task";
import type { TerminalRuntime } from "@portable-devshell/core/terminal";
import type {
    ToolCallDispatchRequest,
    ToolCallExecutionRuntime,
    ToolCallTarget,
} from "@portable-devshell/core/toolcall";
import type {
    ControlInstanceConfig,
    JsonValue,
} from "@portable-devshell/shared";

import type { ToolCallRegistry } from "../toolcall/Public.js";

export interface InstanceRuntime {
    readonly approval: ApprovalRuntime;
    readonly audit: AuditRuntime;
    readonly instance: Instance;
    readonly task: TaskRuntime;
    readonly terminal: TerminalRuntime;
    readonly tools: ToolCallExecutionRuntime;
    callTool(request: ToolCallDispatchRequest): Promise<JsonValue>;
    close(): Promise<void>;
    openToolSession(
        workspace: string,
        connectionId: string,
    ): Promise<WorkerWorkspacePrepareResult>;
    prepareRetirement(): Promise<void>;
    refreshTools(): Promise<void>;
    releaseToolSession(connectionId: string): Promise<void>;
    retire(): Promise<void>;
    target(): ToolCallTarget;
}

export interface InstanceRuntimeOptions {
    config: ControlInstanceConfig;
    homeDirectory: string;
    toolCalls: ToolCallRegistry;
}

export interface InstanceRuntimeRegistry {
    close(): Promise<void>;
    create(config: ControlInstanceConfig): Instance;
    finalize(instance: Instance): Promise<void>;
    get(instance: Instance): InstanceRuntime;
    retire(instance: Instance): Promise<void>;
}

export interface InstanceRuntimeRegistryOptions {
    homeDirectory?: string;
    toolCalls: ToolCallRegistry;
}
