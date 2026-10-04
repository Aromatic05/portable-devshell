import type { TodoTaskSummary } from "@portable-devshell/shared";
import type { McpAppAction, McpAppResolvedAction, McpAppWorkItem } from "../model/Contract.js";
import { mcpAppIdentity } from "../model/Identity.js";

const actionView: Record<"task-pause" | "task-resume" | "task-cancel", Omit<McpAppAction, "id">> = {
    "task-pause": { label: "Pause", tone: "default" },
    "task-resume": { label: "Resume", tone: "primary" },
    "task-cancel": { label: "Cancel", tone: "danger", confirmation: { message: "Cancel this task?" } },
};

export function contributeTodo(
    tasks: TodoTaskSummary[], ctxId: string, instance: string,
    controlAvailable: boolean,
): { items: McpAppWorkItem[]; actions: McpAppResolvedAction[]; modelTasks: TodoTaskSummary[] } {
    const items: McpAppWorkItem[] = [];
    const actions: McpAppResolvedAction[] = [];
    const modelTasks: TodoTaskSummary[] = [];
    for (const task of tasks) {
        if (task.ctxId !== ctxId) continue;
        modelTasks.push(task);
        if (task.status === "completed" || task.status === "cancelled" || task.status === "failed" || task.status === "none") continue;
        const state = task.status === "paused" ? "paused" : task.status === "blocked" ? "blocked" : "running";
        const operations: Array<keyof typeof actionView> = task.status === "paused" ? ["task-resume", "task-cancel"] : ["task-pause", "task-cancel"];
        if (controlAvailable) for (const operation of operations) {
            const actionId = mcpAppIdentity(ctxId, instance, task.taskId, operation, task.revision);
            actions.push({ itemId: task.taskId, actionId, instance, operation, targetId: task.taskId, revision: task.revision });
        }
        items.push({ kind: "work", id: task.taskId, title: task.title, state, ...(task.checkpoint?.summary ? { detail: task.checkpoint.summary } : {}), ...(task.currentItem ?? task.checkpoint?.next ? { current: task.currentItem ?? task.checkpoint?.next } : {}), progress: { current: task.completed, total: task.total }, actions: controlAvailable ? operations.map((operation) => ({ id: mcpAppIdentity(ctxId, instance, task.taskId, operation, task.revision), ...actionView[operation] })) : [] });
    }
    return { items, actions, modelTasks };
}
