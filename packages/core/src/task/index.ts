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
        leases: options.waitLeases,
    });
    return {
        api: { goal, wait },
        beginWaitCall: (callId) => wait.beginCall(callId),
        finishWaitCall: (callId) => wait.finishCall(callId),
        close: async () => await wait.close(),
        resume: () => wait.resume(),
    };
}
