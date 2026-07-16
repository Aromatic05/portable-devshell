import type { TodoItem, TodoReadResult } from "@portable-devshell/shared";

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
        return "Todo: none\n";
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

function renderItem(item: TodoItem): string {
    const detail = item.detail === undefined ? "" : ` — ${item.detail}`;
    return `${symbols[item.status]} ${item.content}${detail}`;
}
