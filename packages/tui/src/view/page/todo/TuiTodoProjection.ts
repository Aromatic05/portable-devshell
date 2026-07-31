import type { TodoReadResult, TodoTaskSummary } from "@portable-devshell/shared";

export function projectTodoSummaries(todo: TodoReadResult | undefined): TodoTaskSummary[] {
    if (todo === undefined) return [];
    const summaries = new Map((todo.tasks ?? []).map((task) => [task.taskId, task]));
    if (todo.taskId !== undefined) {
        const current = todo.summary.currentItemId === undefined
            ? undefined
            : todo.items.find((item) => item.id === todo.summary.currentItemId)?.content;
        const existing = summaries.get(todo.taskId);
        summaries.set(todo.taskId, {
            completed: todo.summary.completed,
            currentItem: current,
            revision: todo.revision,
            status: activeTodoStatus(todo),
            taskId: todo.taskId,
            title: todo.title ?? todo.taskId,
            total: todo.summary.total,
            updatedAt: existing?.updatedAt ?? "-",
            ...(existing?.ctxId === undefined ? {} : { ctxId: existing.ctxId })
        });
    }
    return [...summaries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function activeTodoStatus(todo: TodoReadResult): TodoTaskSummary["status"] {
    if (todo.items.some((item) => item.status === "failed")) return "failed";
    if (todo.items.some((item) => item.status === "blocked")) return "blocked";
    if (todo.items.some((item) => item.status === "in_progress")) return "in_progress";
    if (todo.summary.total > 0 && todo.summary.completed === todo.summary.total) return "completed";
    return todo.summary.total === 0 ? "none" : "pending";
}
