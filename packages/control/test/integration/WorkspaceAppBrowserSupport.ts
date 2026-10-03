export const WORKSPACE_FIXTURE_PROTOCOL = String.raw`
window.projectWorkspaceFixture = function (source, modelContext) {
    var state = source || {};
    var actions = function (pairs) { return pairs.map(function (pair) { var action = { id: pair[0], label: pair[1] }; if (pair[2]) action.confirmation = { message: pair[2] }; return action; }); };
    var work = (state.tasks || []).filter(function (task) { return task.status !== "completed" && task.status !== "cancelled"; }).map(function (task) {
        return { kind: "work", id: task.taskId, title: "Task · " + (task.title || task.taskId), state: task.status === "paused" ? "paused" : task.status === "blocked" ? "blocked" : "running", badge: task.status === "paused" ? "Paused" : task.status === "blocked" ? "Blocked" : "Running", current: task.currentItem, detail: task.checkpoint && task.checkpoint.summary, progress: typeof task.completed === "number" && typeof task.total === "number" ? { current: task.completed, total: task.total } : undefined, actions: actions([[task.status === "paused" || task.status === "blocked" ? "task-resume" : "task-pause", task.status === "paused" || task.status === "blocked" ? "Resume task" : "Pause task"], ["task-cancel", "Cancel task", "Cancel this task?"]]) };
    });
    if (state.goal && state.goal.status !== "stopped" && state.goal.status !== "completed") {
        var goal = state.goal;
        work.push({ kind: "work", id: goal.goalId, title: goal.objective, state: goal.status === "blocked" ? "blocked" : goal.status === "paused" ? "paused" : "running", badge: goal.continuationUncertain ? "Delivery uncertain" : goal.autoContinueExhausted ? "Resume paused" : goal.status === "blocked" ? "Blocked" : goal.status === "paused" ? "Paused" : "Active", current: goal.steps && goal.steps.find(function (step) { return step.status === "active" || step.status === "pending"; })?.text, note: goal.note, detail: goal.status === "blocked" && goal.note ? "Reason: " + goal.note : undefined, progress: goal.steps && goal.steps.length ? { current: goal.steps.filter(function (step) { return step.status === "completed"; }).length, total: goal.steps.length } : undefined, actions: actions([[goal.status === "blocked" || goal.status === "paused" ? "goal-resume" : "goal-pause", goal.status === "blocked" || goal.status === "paused" ? "Resume Goal" : "Pause Goal"], ...(goal.continuationUncertain || goal.autoContinueExhausted ? [["goal-retry", "Retry Goal"]] : []), ["goal-stop", "Stop Goal", "Stop this Goal?"]]) });
    }
    var question = (state.questions || []).find(function (item) { return item.status === "waiting" || item.status === "detached"; });
    var approval = (state.approvals || []).find(function (item) { return item.status === "waiting"; });
    var primary;
    if (question) {
        var choices = question.payload && question.payload.choices || [];
        primary = { kind: "question", id: question.waitId || question.targetId, title: "Question", prompt: question.payload && question.payload.question || "", input: choices.length ? { kind: "choice", allowText: !!question.payload.allowText, choices: choices.map(function (label) { return { id: String(label), label: String(label) }; }) } : { kind: "text", placeholder: "Type an answer" }, actions: actions([["answer", choices.length ? "Continue" : "Send"]]) };
    } else if (approval) {
        primary = { kind: "decision", id: approval.approvalId, title: "Approval required", badge: "High risk", summary: approval.inputSummary, detail: approval.reason, actions: actions([["approve", "Approve"], ["deny", "Deny"]]) };
    }
    var background = (state.background || []).map(function (wait) { return { kind: "background", id: wait.waitId, title: "Background task", badge: "Waiting for task to finish", summary: wait.status === "resolved" ? "Task finished" : undefined, actions: actions([[wait.status === "resolved" ? "dismiss" : "interrupt", wait.status === "resolved" ? "Dismiss recovery" : "Stop waiting"]]) }; });
    var reentry = state.reentry || {};
    var automatic = reentry.mode === "automatic" && !reentry.suppressedAt && !reentry.pending && !state.agentBusy && !primary;
    var pendingBackground = (state.background || []).some(function (wait) { return wait.status === "waiting" || wait.status === "detached"; });
    var goalSchedule = automatic && !pendingBackground && state.goal && state.goal.status === "active" && state.goal.continuationDue && !state.goal.continuationPending && !state.goal.continuationUncertain && !state.goal.autoContinueExhausted && state.goal.steps && state.goal.steps.some(function (step) { return step.status === "active" || step.status === "pending"; }) ? { readyAt: state.goal.continuationRetryAfter || state.goal.continuationDueAt, intent: "automatic", sourceId: state.goal.goalId } : undefined;
    var recoverable = automatic && (state.background || []).find(function (wait) { return wait.status === "resolved" && wait.detachedAt && !wait.recoveryMessageAttemptedAt && !wait.recoveryMessageSentAt && !wait.recoveryDisabledAt; });
    var schedule = reentry.schedule || (recoverable ? { readyAt: recoverable.updatedAt, intent: "automatic", sourceId: recoverable.waitId } : goalSchedule);
    var modelState = { ctxId: state.ctxId, instance: state.instance, goal: state.goal, tasks: state.tasks || [], background: state.background || [] };
    var projected = { ctxId: state.ctxId, instance: state.instance, cursor: state.cursor || 0, agentBusy: !!state.agentBusy, presentation: { primary: primary, work: work, background: background }, modelContext: modelContext || { content: [{ type: "text", text: "Workspace fixture model context\n" + JSON.stringify(modelState) }], structuredContent: { portableDevshellWorkspace: modelState } }, reentry: { pending: !!reentry.pending || !!(state.goal && state.goal.continuationPending) || !!schedule, executionActive: !!reentry.executionActive, schedule: schedule, delivery: reentry.delivery || { status: "idle" }, directives: reentry.directives || [] } };
    (window.__workspaceProjectedSnapshots || (window.__workspaceProjectedSnapshots = [])).push(projected);
    return projected;
};
`;
