import { workspaceFolderName, type GoalSnapshot, type TodoItem, type TodoTaskSummary } from "@portable-devshell/shared";

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
    pending: "○",
};


export function buildTodoGoalBoxes(state: TuiAppState, instance: string): BoxModel[] {
    const goals = state.readModel.instanceState[instance]?.goals ?? [];
    return goals.map((goal) => goalBox(state, instance, goal));
}

function goalBox(state: TuiAppState, instance: string, goal: GoalSnapshot): BoxModel {
    const completed = goal.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
    return makeBox(state, "todo", instance, {
        detailLines: [
            formatField("Goal", goal.goalId),
            formatField("Revision", String(goal.revision)),
            formatField("Status", goal.status),
            formatField("Progress", `${completed}/${goal.steps.length} steps`),
            formatField("Workspace", workspaceFolderName(goal.workspace)),
            ...goal.steps.map((step) => formatField(step.status, step.text)),
        ],
        id: `todo-goal:${goal.goalId}`,
        searchText: `${goal.goalId} ${goal.objective} ${goal.status} ${goal.workspace ?? ""}`,
        status: goal.status === "blocked" ? "warning" : goal.status === "active" ? "running" : goal.status === "completed" ? "ready" : "disabled",
        summaryLines: [
            compactSummary(["progress", `${completed}/${goal.steps.length}`], ["status", goal.status], ["workspace", workspaceFolderName(goal.workspace)]),
        ],
        title: `Goal · ${goal.objective}`,
    });
}

export function buildTodoOverviewBoxes(state: TuiAppState, instance: string): BoxModel[] {
    const todo = state.readModel.instanceState[instance]?.todo;
    const summaries = projectTodoSummaries(todo);
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
    const activeTaskId = todo?.taskId;
    return [
        ...summaries.map((task) => taskBox(state, instance, task)),
        ...(activeTaskId === undefined || todo === undefined
            ? []
            : todo.items.map((item) => subTaskBox(state, instance, activeTaskId, item)))
    ];
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

function subTaskBox(state: TuiAppState, instance: string, taskId: string, item: TodoItem): BoxModel {
    return makeBox(state, "todo", instance, {
        detailLines: [
            formatField("ID", item.id),
            formatField("Status", item.status),
            formatField("Content", item.content),
            ...(item.detail === undefined ? [] : [formatField("Detail", item.detail)])
        ],
        id: `todo-item:${item.id}`,
        primaryRoute: { page: "todo", todoId: taskId, view: "detail" },
        status: itemStatus(item.status),
        summaryLines: [`${symbols[item.status]} ${item.content}`],
        title: item.content
    });
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
