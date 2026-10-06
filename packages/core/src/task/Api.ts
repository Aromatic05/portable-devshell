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
