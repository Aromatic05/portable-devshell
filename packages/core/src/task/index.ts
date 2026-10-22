import type { TaskRuntimeOptions, TaskRuntime } from "./Api.js";



import { GoalService } from "./goal/index.js";
import { WaitService } from "./wait/index.js";







export function createTaskRuntime(options: TaskRuntimeOptions): TaskRuntime {
    const appendEvent = options.appendEvent;
    const goal = new GoalService({
        appendEvent,
        filePath: options.paths.goalsFile,
        instanceName: options.instanceName,
    });
    const wait = new WaitService({
        appendEvent,
        filePath: options.paths.waitsFile,
        invoke: { invoke: options.invokeTool },
    });
    return {
        api: { goal, wait },
        close: async () => await wait.close(),
        resume: () => wait.resume(),
    };
}
