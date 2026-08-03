import type { TodoItem, TodoReadResult, TodoTaskSummary } from "@portable-devshell/shared";

const symbols: Record<TodoItem["status"], string> = {
    blocked: "!",
    cancelled: "-",
    completed: "✓",
    failed: "×",
    in_progress: "●",
    pending: "○",
};

export function renderInstanceTodo(todo: TodoReadResult): string {
    if (todo.taskId === undefined) {
        const tasks = todo.tasks ?? [];
        if (tasks.length === 0) {
            return "Todo: none\n";
        }
        return `Tasks:\n${tasks.map(renderTaskSummary).join("\n")}\n`;
    }

    const current = todo.items.find(
        (item) => item.id === todo.summary.currentItemId,
    );
    const lines = [
        `Task: ${todo.title ?? todo.taskId}`,
        `Progress: ${todo.summary.completed}/${todo.summary.total}`,
        `Current: ${current?.content ?? "none"}`,
        "",
        ...todo.items.map(renderItem),
    ];
    return `${lines.join("\n")}\n`;
}

function renderTaskSummary(task: TodoTaskSummary): string {
    const symbol = task.status === "none" ? "·" : symbols[task.status];
    const current = task.currentItem === undefined ? "" : ` — ${task.currentItem}`;
    return `${symbol} ${task.title} [${task.completed}/${task.total}]${current}`;
}

function renderItem(item: TodoItem): string {
    const detail = item.detail === undefined ? "" : ` — ${item.detail}`;
    return `${symbols[item.status]} ${item.content}${detail}`;
}
