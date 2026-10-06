import type { ApprovalRuntime } from "@portable-devshell/core/approval";
import type { AuditRuntime } from "@portable-devshell/core/audit";
import type {
    Instance,
    InstanceRegistry,
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
    ControlConfig,
    ControlInstanceConfig,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue,
} from "@portable-devshell/shared";

import type { ToolCallRegistry } from "../toolcall/Api.js";
import type { InstanceChangeHub } from "./Change.js";

export interface InstanceCreatePort {
    createInstance(params?: JsonValue): Promise<InstanceCreateResult>;
    getSchema(): InstanceCreateSchema;
    validateDraft(params?: JsonValue): InstanceCreateSummary;
}

export interface InstanceEditorPort {
    deleteInstance(params?: JsonValue): Promise<JsonValue>;
    disableInstance(params?: JsonValue): Promise<JsonValue>;
    enableInstance(params?: JsonValue): Promise<JsonValue>;
    updateInstanceConfig(params?: JsonValue): Promise<JsonValue>;
}

export interface InstanceConfigRouteModuleOptions {
    changes: InstanceChangeHub;
    configuredInstances?: () => readonly ControlConfig["instances"][number][];
    create?: InstanceCreatePort;
    editor?: InstanceEditorPort;
    registry: InstanceRegistry;
}

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
