import type { GoalSnapshot } from "@portable-devshell/shared";
import type { BoxModel } from "../../component/content/Box.js";
import { workspaceFolderName } from "../../presentation/Workspace.js";
import type { TuiAppState } from "../../../state/store/Model.js";
import type { TuiDomainReader } from "../../../app/control/Reader.js";
import { compactSummary, formatField, makeBox } from "../Support.js";

function goalBox(state: TuiAppState, instance: string, goal: GoalSnapshot): BoxModel {
    return makeBox(state, "goals", instance, {
        detailLines: [
            formatField("Goal", goal.goalId),
            formatField("Revision", String(goal.revision)),
            formatField("Status", goal.status),
            formatField("Workspace", workspaceFolderName(goal.workspace)),
            ...(goal.note === undefined ? [] : [formatField("Note", goal.note)]),
        ],
        id: `goal:${goal.goalId}`,
        searchText: `${goal.goalId} ${goal.objective} ${goal.status} ${goal.workspace ?? ""}`,
        status: goal.status === "blocked" ? "warning" : goal.status === "active" ? "running" :
            goal.status === "completed" ? "ready" : "disabled",
        summaryLines: [compactSummary(["status", goal.status], ["workspace", workspaceFolderName(goal.workspace)])],
        title: `Goal · ${goal.objective}`,
    });
}

export function buildGoalsPageBoxes(
    state: TuiAppState, reader: TuiDomainReader, instance: string,
): BoxModel[] {
    const snapshot = reader.goals.instances[instance];
    const goals = snapshot?.goals ?? [];
    const failure = snapshot?.failure;
    const warning = failure === undefined ? [] : [makeBox(state, "goals", instance, {
        detailLines: [failure.message, "Retry by refreshing this Instance."],
        expandable: true,
        id: "goals-error",
        status: "warning",
        summaryLines: [failure.message],
        title: "Goals could not be loaded",
    })];
    if (goals.length === 0 && failure !== undefined) return warning;
    if (goals.length === 0 && snapshot === undefined) return [makeBox(state, "goals", instance, {
        detailLines: ["Workspace Goals have not been loaded."],
        expandable: false,
        id: "goals-loading",
        status: "normal",
        summaryLines: ["status=loading"],
        title: "Goals",
    })];
    if (goals.length === 0) return [makeBox(state, "goals", instance, {
        detailLines: ["No active Workspace Goal for this instance."],
        expandable: false,
        id: "goals-empty",
        status: "normal",
        summaryLines: ["status=none"],
        title: "Goals",
    })];
    return [...warning, ...goals.map((goal) => goalBox(state, instance, goal))];
}
