import type { TodoItem, TodoReadResult } from "@portable-devshell/shared";

import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiExpandableBoxStatus } from "../TuiUiModel.js";
import type { TuiAppState } from "../../state/TuiStoreTypes.js";
import { compactSummary, formatField, makeBox } from "./TuiPageBoxSupport.js";

const symbols: Record<TodoItem["status"], string> = {
    blocked: "!",
    cancelled: "-",
    completed: "✓",
    failed: "×",
    in_progress: "●",
    pending: "○",
};

export function buildTodoPageBoxes(
    state: TuiAppState,
    instanceName: string,
): BoxModel[] {
    const todo = state.todoByInstance[instanceName];

    if (todo?.taskId === undefined) {
        return [
            makeBox(state, "todo", instanceName, {
                detailLines: ["No active todo for this instance."],
                id: "todo-empty",
                status: "normal",
                summaryLines: [compactSummary(["status", "none"])],
                title: "Todo",
            }),
        ];
    }

    const current = currentItem(todo);
    return [
        makeBox(state, "todo", instanceName, {
            detailLines: [
                formatField("Task", todo.title ?? todo.taskId),
                formatField("Task ID", todo.taskId),
                formatField("Revision", String(todo.revision)),
                formatField(
                    "Progress",
                    `${todo.summary.completed}/${todo.summary.total}`,
                ),
                formatField("Current", current?.content ?? "none"),
            ],
            id: "todo-summary",
            status: summaryStatus(todo),
            summaryLines: [
                compactSummary(
                    [
                        "progress",
                        `${todo.summary.completed}/${todo.summary.total}`,
                    ],
                    ["revision", String(todo.revision)],
                ),
                `Current: ${current?.content ?? "none"}`,
            ],
            title: todo.title ?? todo.taskId,
        }),
        ...todo.items.map((item) => todoItemBox(state, instanceName, item)),
    ];
}

function todoItemBox(
    state: TuiAppState,
    instanceName: string,
    item: TodoItem,
): BoxModel {
    return makeBox(state, "todo", instanceName, {
        detailLines: [
            formatField("ID", item.id),
            formatField("Status", item.status),
            formatField("Content", item.content),
            ...(item.detail === undefined
                ? []
                : [formatField("Detail", item.detail)]),
        ],
        id: `todo-item:${item.id}`,
        status: itemStatus(item.status),
        summaryLines: [`${symbols[item.status]} ${item.content}`],
        title: item.content,
    });
}

function currentItem(todo: TodoReadResult): TodoItem | undefined {
    const currentItemId = todo.summary.currentItemId;
    return currentItemId === undefined
        ? undefined
        : todo.items.find((item) => item.id === currentItemId);
}

function summaryStatus(todo: TodoReadResult): TuiExpandableBoxStatus {
    if (todo.items.some((item) => item.status === "in_progress")) {
        return "running";
    }
    if (todo.items.some((item) => item.status === "failed")) {
        return "failed";
    }
    if (todo.items.some((item) => item.status === "blocked")) {
        return "warning";
    }
    if (
        todo.summary.total > 0 &&
        todo.summary.completed === todo.summary.total
    ) {
        return "ready";
    }
    return "normal";
}

function itemStatus(status: TodoItem["status"]): TuiExpandableBoxStatus {
    switch (status) {
        case "in_progress":
            return "running";
        case "completed":
            return "ready";
        case "blocked":
            return "warning";
        case "failed":
            return "failed";
        case "cancelled":
            return "disabled";
        case "pending":
            return "normal";
    }
}
