import type { OperationalOverviewTodo } from "@portable-devshell/shared";

import type { TuiAppState } from "../../state/reducer/TuiStoreModel.js";
import type { TuiExpandableBoxStatus } from "../../state/TuiUiState.js";
import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import { buttonLine } from "../editor/TuiEditorView.js";
import {
    compactSummary,
    formatField,
    makeBox
} from "./TuiPageBoxSupport.js";

export function buildOverviewTodoBoxes(
    state: TuiAppState,
    todos: readonly OperationalOverviewTodo[]
): BoxModel[] {
    if (todos.length === 0) {
        return [makeBox(state, "overview", undefined, {
            detailLines: [
                "No failed, blocked, or in-progress tasks require attention.",
                "Use the Todo page for the complete per-instance task list."
            ],
            id: "overview-todos-clear",
            status: "ready",
            summaryLines: ["No actionable todos."],
            title: "Todos · read-only"
        })];
    }
    return todos.map((todo) => buildTodoBox(state, todo));
}

function buildTodoBox(
    state: TuiAppState,
    todo: OperationalOverviewTodo
): BoxModel {
    return makeBox(state, "overview", undefined, {
        detailLines: [
            formatField("Instance", todo.instance),
            formatField("Status", todo.status),
            formatField("Progress", `${todo.completed}/${todo.total}`),
            formatField("Revision", String(todo.revision)),
            ...(todo.currentItem === undefined
                ? []
                : [formatField("Current", todo.currentItem)]),
            formatField("Task ID", todo.taskId),
            buttonLine(
                `overview-open-todo:${encodeURIComponent(todo.instance)}`,
                "Open Todo"
            )
        ],
        id: `overview-todo:${todo.instance}:${todo.taskId}`,
        searchText: `${todo.instance} ${todo.title} ${todo.status} ${todo.currentItem ?? ""}`,
        status: todoStatus(todo),
        summaryLines: [
            compactSummary(
                ["instance", todo.instance],
                ["status", todo.status],
                ["progress", `${todo.completed}/${todo.total}`]
            ),
            todo.currentItem ?? "No current item."
        ],
        title: `Todo · ${todo.title}`
    });
}

function todoStatus(todo: OperationalOverviewTodo): TuiExpandableBoxStatus {
    switch (todo.status) {
        case "none":
            return "normal";
        case "completed":
            return "ready";
        case "in_progress":
            return "running";
        case "pending":
            return "pending";
        case "cancelled":
            return "disabled";
        case "blocked":
            return "warning";
        case "failed":
            return "failed";
    }
}
