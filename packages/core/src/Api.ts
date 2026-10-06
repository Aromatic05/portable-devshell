import type { ControlInstanceConfig, JsonValue } from "@portable-devshell/shared";
import type { ApprovalRuntime } from "./approval/Api.js";
import type { AuditRuntime } from "./audit/Api.js";
import type { Instance } from "./instance/Instance.js";
import type { WorkerWorkspacePrepareResult } from "./instance/Api.js";
import type { TaskRuntime } from "./task/Api.js";
import type { TerminalRuntime } from "./terminal/Api.js";
import type {
    ToolCallDispatchRequest,
    ToolCallExecutionRuntime,
    ToolCallTarget,
} from "./toolcall/Api.js";

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

export interface InstanceRuntimeRegistry {
    close(): Promise<void>;
    create(config: ControlInstanceConfig): Instance;
    finalize(instance: Instance): Promise<void>;
    get(instance: Instance): InstanceRuntime;
    retire(instance: Instance): Promise<void>;
}
