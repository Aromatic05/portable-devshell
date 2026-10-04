import type { InstanceName, JsonValue, ToolCallContext } from "@portable-devshell/shared";

import type { TaskApi } from "./Api.js";
import { GoalService } from "./goal/Service.js";
import { TodoService } from "./todo/Service.js";
import { WaitService } from "./wait/Service.js";

export interface InstanceTaskPaths {
    goalsFile: string;
    todoFile: string;
    waitsFile: string;
}

export interface InstanceTaskServiceOptions {
    appendEvent(type: string, data: JsonValue): Promise<void>;
    instanceName: InstanceName;
    invokeTool(
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
    ): Promise<JsonValue>;
    paths: InstanceTaskPaths;
}

export function createInstanceTaskServices(
    options: InstanceTaskServiceOptions,
): TaskApi {
    const appendEvent = options.appendEvent;
    return {
        goal: new GoalService({
            appendEvent,
            filePath: options.paths.goalsFile,
            instanceName: options.instanceName,
        }),
        todo: new TodoService({
            appendEvent,
            filePath: options.paths.todoFile,
            instanceName: options.instanceName,
        }),
        wait: new WaitService({
            appendEvent,
            filePath: options.paths.waitsFile,
            invoke: { invoke: options.invokeTool },
        }),
    };
}
