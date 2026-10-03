import type { GoalSnapshot } from "@portable-devshell/shared";
import type { WorkspaceAction, WorkspaceResolvedAction, WorkspaceWorkItem } from "../model/Contract.js";
import { workspaceIdentity } from "../model/Identity.js";

const actionView: Record<"goal-pause" | "goal-resume" | "goal-retry" | "goal-stop", Omit<WorkspaceAction, "id">> = {
    "goal-pause": { label: "Pause Goal", tone: "default" },
    "goal-resume": { label: "Resume Goal", tone: "primary" },
    "goal-retry": { label: "Retry Goal", tone: "primary" },
    "goal-stop": { label: "Stop Goal", tone: "danger", confirmation: { message: "Stop this Goal?" } },
};

export function contributeGoal(goal: GoalSnapshot | undefined, ctxId: string, instance: string, epoch = 0) {
    if (!goal || goal.status === "completed" || goal.status === "stopped") return { item: undefined, actions: [] as WorkspaceResolvedAction[] };
    const operations: Array<keyof typeof actionView> = [];
    if (goal.status === "active") operations.push("goal-pause", "goal-stop");
    if (goal.status === "paused" || goal.status === "blocked") operations.push("goal-resume", "goal-stop");
    if (goal.status === "active" && (goal.continuationUncertain || goal.autoContinueExhausted)) operations.push("goal-retry");
    const actions = operations.map((operation) => ({ itemId: goal.goalId, actionId: workspaceIdentity(ctxId, instance, goal.goalId, operation, `${goal.revision}:${epoch}`), instance, operation, targetId: goal.goalId, revision: goal.revision }));
    const current = goal.steps.find((step) => step.status === "active") ?? goal.steps.find((step) => step.status === "pending");
    const completed = goal.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
    const badge = goal.continuationUncertain ? "Delivery uncertain" : goal.autoContinueExhausted ? "Resume paused" : goal.status === "blocked" ? "Blocked" : goal.status === "paused" ? "Paused" : "Active";
    const details = [
        goal.status === "blocked" && goal.note ? `Reason: ${goal.note}` : undefined,
        goal.continuationUncertain ? "Automatic retry stopped to avoid duplicate agent execution. Continue manually in chat or stop this Goal." : undefined,
        goal.autoContinueExhausted ? "The automatic no-progress retry limit was reached. The Goal remains active." : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    const item: WorkspaceWorkItem = {
        kind: "work", id: goal.goalId, title: goal.objective, badge,
        state: goal.status === "paused" ? "paused" : goal.status === "blocked" ? "blocked" : "running",
        ...(details.length ? { detail: details.join("\n\n") } : {}),
        ...(current ? { current: current.text } : {}), ...(current?.note ? { note: current.note } : {}),
        progress: { current: completed, total: goal.steps.length },
        actions: operations.map((operation) => ({ id: workspaceIdentity(ctxId, instance, goal.goalId, operation, `${goal.revision}:${epoch}`), ...actionView[operation] })),
    };
    return { item, actions };
}
