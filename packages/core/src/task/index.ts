import type { InstanceName, JsonValue, ToolCallContext } from "@portable-devshell/shared";

import type { TaskApi } from "./Api.js";
import { GoalService } from "./goal/index.js";
import { TodoService } from "./todo/index.js";
import { WaitService } from "./wait/index.js";

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

export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntime {
    const appendEvent = options.appendEvent;
    const goal = new GoalService({
        appendEvent,
        filePath: options.paths.goalsFile,
        instanceName: options.instanceName,
    });
    const todo = new TodoService({
        appendEvent,
        filePath: options.paths.todoFile,
        instanceName: options.instanceName,
    });
    const wait = new WaitService({
        appendEvent,
        filePath: options.paths.waitsFile,
        invoke: { invoke: options.invokeTool },
    });
    return {
        api: { goal, todo, wait },
        close: async () => await wait.close(),
        resume: () => wait.resume(),
    };
}
