import type { ControlPortContext, InstanceEventRecord, MessageStream, TaskEvent } from "@portable-devshell/shared";
import type { InstanceEventSource } from "../instance/Public.js";
import type { InstanceName, ToolCallContext } from "@portable-devshell/shared";
import type {
    ActiveTodoSummary,
    GoalActivityKind,
    GoalContinuationInput,
    GoalManageInput,
    GoalSnapshot,
    JsonValue,
    TodoReadInput,
    TodoReadResult,
    TodoTaskControlAction,
    TodoWriteInput,
    WaitDetachInput,
    WaitRecord,
} from "@portable-devshell/shared";

export interface TodoApi {
    cancelAll(): Promise<void>;
    control(
        taskId: string,
        action: TodoTaskControlAction,
        ctxId: string,
        expectedRevision?: number,
    ): Promise<TodoReadResult>;
    delete(taskId: string): Promise<void>;
    read(input?: TodoReadInput): Promise<TodoReadResult>;
    summaries(): ActiveTodoSummary[];
    write(input: TodoWriteInput, ctxId: string): Promise<TodoReadResult>;
}

export interface GoalApi {
    continuation(ctxId: string, input: GoalContinuationInput): Promise<JsonValue>;
    list(): Promise<GoalSnapshot[]>;
    stopAll(): Promise<GoalSnapshot[]>;
    manage(ctxId: string, input: GoalManageInput): Promise<GoalSnapshot | undefined>;
    read(ctxId: string): Promise<GoalSnapshot | undefined>;
    recordReentry(ctxId: string, progressEpoch?: number): Promise<void>;
    touch(ctxId: string, kind?: GoalActivityKind): Promise<void>;
}

export interface WaitApi {
    detach(input: WaitDetachInput): Promise<WaitRecord>;
    list(ctxId?: string): Promise<WaitRecord[]>;
}

export interface TaskApi {
    readonly goal: GoalApi;
    readonly todo: TodoApi;
    readonly wait: WaitApi;
}

export interface TaskPaths {
    goalsFile: string;
    todoFile: string;
    waitsFile: string;
}

export interface TaskRuntimeOptions {
    appendEvent(type: string, data: JsonValue): Promise<void>;
    instanceName: InstanceName;
    invokeTool(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    paths: TaskPaths;
}

export interface TaskRuntime {
    readonly api: TaskApi;
    close(): Promise<void>;
    resume(): void;
}

export interface GoalTaskRouteInstancePort {
    events: Pick<InstanceEventSource, "cursor">;
    goal: Pick<GoalApi, "list">;
}

export interface TodoTaskRouteSubscriptionPort {
    subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: Pick<InstanceEventSource, "subscribe">,
        fromSeq: number,
        projectEvent?: (event: InstanceEventRecord) => TaskEvent | undefined,
    ): Promise<void>;
}

export interface TodoTaskRouteInstancePort {
    events: InstanceEventSource;
    name: string;
    todo: Pick<TodoApi, "delete" | "read">;
}
