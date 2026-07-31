import type { TodoItem, TodoReadResult } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import type { TuiExpandableBoxStatus } from "../../../state/TuiUiState.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";
import { projectTodoSummaries } from "./TuiTodoProjection.js";

const symbols: Record<TodoItem["status"], string> = {
    blocked: "!",
    cancelled: "-",
    completed: "✓",
    failed: "×",
    in_progress: "●",
    pending: "○"
};

export function buildTodoDetailBoxes(state: TuiAppState, instance: string, todoId: string): BoxModel[] {
    const todo = state.todoByInstance[instance];
    const summary = projectTodoSummaries(todo).find((candidate) => candidate.taskId === todoId);
    if (summary === undefined) return [];
    if (todo?.taskId !== todoId) {
        return [makeBox(state, "todo", instance, {
            detailLines: [
                formatField("Task", summary.taskId),
                formatField("Revision", String(summary.revision)),
                formatField("Progress", `${summary.completed}/${summary.total}`),
                formatField("Status", summary.status),
                "Full item data is not present in the current read model."
            ],
            id: `todo-summary:${todoId}`,
            status: summary.status === "failed" ? "failed" : summary.status === "blocked" ? "warning" : "normal",
            summaryLines: [compactSummary(["progress", `${summary.completed}/${summary.total}`], ["revision", String(summary.revision)])],
            title: summary.title
        })];
    }

    return [
        summaryBox(state, instance, todo, summary.ctxId),
        ...todo.items.map((item) => itemBox(state, instance, item)),
        ...(todo.comments ?? []).map((comment) => makeBox(state, "todo", instance, {
            detailLines: [
                formatField("Comment", comment.text),
                formatField("Context", comment.ctxId),
                formatField("Created", comment.createdAt),
                formatField("ID", comment.id),
                { id: `button:delete-comment:${comment.id}`, text: "[ Delete Comment ]", tone: "danger" }
            ],
            id: `todo-comment:${comment.id}`,
            status: "warning",
            summaryLines: [comment.text],
            title: "Context Comment"
        }))
    ];
}

function summaryBox(state: TuiAppState, instance: string, todo: TodoReadResult, ctxId: string | undefined): BoxModel {
    const current = todo.summary.currentItemId === undefined ? undefined : todo.items.find((item) => item.id === todo.summary.currentItemId);
    return makeBox(state, "todo", instance, {
        detailLines: [
            formatField("Task", todo.taskId ?? "-"),
            formatField("Revision", String(todo.revision)),
            formatField("Progress", `${todo.summary.completed}/${todo.summary.total}`),
            formatField("Current", current?.content ?? "none"),
            ...(ctxId === undefined ? [] : [{ id: `button:add-comment:${ctxId}`, text: "[ Add Context Comment ]", tone: "accent" as const }])
        ],
        id: `todo-summary:${todo.taskId}`,
        status: summaryStatus(todo),
        summaryLines: [compactSummary(["progress", `${todo.summary.completed}/${todo.summary.total}`], ["revision", String(todo.revision)])],
        title: todo.title ?? todo.taskId ?? "Todo"
    });
}

function itemBox(state: TuiAppState, instance: string, item: TodoItem): BoxModel {
    return makeBox(state, "todo", instance, {
        detailLines: [
            formatField("ID", item.id),
            formatField("Status", item.status),
            formatField("Content", item.content),
            ...(item.detail === undefined ? [] : [formatField("Detail", item.detail)])
        ],
        id: `todo-item:${item.id}`,
        status: itemStatus(item.status),
        summaryLines: [`${symbols[item.status]} ${item.content}`],
        title: item.content
    });
}

function summaryStatus(todo: TodoReadResult): TuiExpandableBoxStatus {
    if (todo.items.some((item) => item.status === "failed")) return "failed";
    if (todo.items.some((item) => item.status === "blocked")) return "warning";
    if (todo.items.some((item) => item.status === "in_progress")) return "running";
    if (todo.summary.total > 0 && todo.summary.completed === todo.summary.total) return "ready";
    return "normal";
}

function itemStatus(status: TodoItem["status"]): TuiExpandableBoxStatus {
    switch (status) {
        case "in_progress": return "running";
        case "completed": return "ready";
        case "blocked": return "warning";
        case "failed": return "failed";
        case "cancelled": return "disabled";
        case "pending": return "normal";
    }
}
