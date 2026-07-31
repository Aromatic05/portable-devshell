import type { TodoTaskSummary } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../../state/reducer/TuiStoreModel.js";
import { compactSummary, formatField, makeBox } from "../TuiPageBoxSupport.js";
import { projectTodoSummaries } from "./TuiTodoProjection.js";

export function buildTodoOverviewBoxes(state: TuiAppState, instance: string): BoxModel[] {
    const summaries = projectTodoSummaries(state.todoByInstance[instance]);
    if (summaries.length === 0) {
        return [makeBox(state, "todo", instance, {
            detailLines: ["No active todo for this instance."],
            expandable: false,
            id: "todo-empty",
            status: "normal",
            summaryLines: ["status=none"],
            title: "Todo"
        })];
    }
    return summaries.map((task) => taskBox(state, instance, task));
}

function taskBox(state: TuiAppState, instance: string, task: TodoTaskSummary): BoxModel {
    return makeBox(state, "todo", instance, {
        detailLines: [
            formatField("Task", task.taskId),
            formatField("Revision", String(task.revision)),
            formatField("Progress", `${task.completed}/${task.total}`),
            formatField("Status", task.status),
            formatField("Current", task.currentItem ?? "none"),
            formatField("Updated", task.updatedAt)
        ],
        id: `todo-task:${task.taskId}`,
        primaryRoute: { page: "todo", todoId: task.taskId, view: "detail" },
        searchText: `${task.taskId} ${task.title} ${task.status}`,
        status: task.status === "failed" ? "failed" : task.status === "blocked" ? "warning" : task.status === "in_progress" ? "running" : task.status === "completed" ? "ready" : "normal",
        summaryLines: [
            compactSummary(["progress", `${task.completed}/${task.total}`], ["revision", String(task.revision)], ["status", task.status]),
            `Current: ${task.currentItem ?? "none"}`
        ],
        title: task.title
    });
}
