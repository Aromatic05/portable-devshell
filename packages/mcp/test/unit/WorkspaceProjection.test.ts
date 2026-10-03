import assert from "node:assert/strict";
import test from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { GoalSnapshot, TodoTaskSummary, WaitRecord } from "@portable-devshell/shared";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import type { McpInteractionGateway } from "../../src/endpoint/Port.js";
import { workspaceSnapshotOutputSchema } from "../../src/endpoint/domain/interaction/Schema.js";
import { contributeGoal } from "../../src/workspace/contributor/Goal.js";
import { contributeTodo } from "../../src/workspace/contributor/Todo.js";
import { contributeWaits } from "../../src/workspace/contributor/Wait.js";
import { projectWorkspaceReentry } from "../../src/workspace/ReentryView.js";
import { readWorkspaceProjection, readWorkspaceSnapshot } from "../../src/workspace/Snapshot.js";

test("Workspace projection keeps context scoped state, stable actions, model context, and re-entry schedule", async () => {
    const gateway = {
        readTodo: async () => ({ tasks: [
            { ctxId: "ctx-a", taskId: "task-a", revision: 4, status: "in_progress", title: "Build", currentItem: "Compile", checkpoint: { summary: "Source ready", next: "Compile" } },
            { ctxId: "ctx-b", taskId: "task-b", revision: 1, status: "in_progress", title: "Other" },
        ] }),
        listWaits: async () => [{ waitId: "wait-a", createdByCtxId: "ctx-a", kind: "tmux", targetId: "tmux-a", status: "resolved", detachedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:01:00.000Z", result: { output: "ready" } }],
        createWait: async () => ({}), detachWait: async () => ({}), consumeWait: async () => ({}), resolveWait: async () => ({}), waitForWait: async () => ({}),
        readGoal: async () => ({ goalId: "goal-a", revision: 8, status: "active", objective: "Ship safely", steps: [{ id: "step-a", status: "active", text: "Review" }], continuationDue: true, continuationDueAt: "2026-10-01T00:02:00.000Z", continuationUncertain: false }),
        goalContinuation: async () => ({}), manageGoal: async () => undefined,
        approval: { listPendingApprovals: async (instance: string) => instance === "beta" ? [{ approvalId: "approval-b", ctxId: "ctx-a", status: "pending", toolName: "shell", createdAt: "2026-10-01T00:00:00.000Z", inputSummary: "run build" }] : [], decideApproval: async () => ({}) },
        controlTodo: async () => ({}),
        hasActiveToolCalls: () => false,
        readToolCalls: async () => [],
        readWorkspaceEvents: async () => ({ events: [], gap: false, lastSeq: 19 }),
    } as unknown as McpInteractionGateway;
    const options = { instances: ["beta"], reentry: { epoch: 3, mode: "automatic", pending: false, executionActive: false }, directives: [{ kind: "reentry" as const, intent: "goal-resume" as const, sourceId: "goal-a", id: "directive-a" }] };
    const first = await readWorkspaceProjection(gateway, "alpha", "ctx-a", options);
    const second = await readWorkspaceProjection(gateway, "alpha", "ctx-a", options);

    assert.equal(first.snapshot.cursor, 19);
    assert.equal(first.snapshot.presentation.primary?.kind, "decision");
    assert.equal(first.snapshot.presentation.primary?.id, "approval-b");
    assert.equal(first.snapshot.presentation.work[0]?.kind, "work");
    assert.equal(first.snapshot.presentation.background[0]?.id, "wait-a");
    assert.equal(first.snapshot.reentry.schedule?.sourceId, "wait-a");
    assert.equal(first.snapshot.reentry.directives?.[0]?.id, "directive-a");
    const modelState = first.snapshot.modelContext.structuredContent.portableDevshellWorkspace as { goal: unknown };
    assert.notEqual(modelState.goal, null);
    assert.equal(JSON.stringify(first.snapshot.modelContext).includes("Source ready"), true);
    assert.equal(JSON.stringify(first.snapshot.presentation).includes("checkpoint"), false);
    assert.equal(JSON.stringify(first.snapshot.presentation).includes("continuationDue"), false);
    assert.equal(first.actions.find((action) => action.targetId === "task-a")?.actionId, second.actions.find((action) => action.targetId === "task-a")?.actionId);
    assert.equal(first.actions.find((action) => action.targetId === "goal-a" && action.operation === "goal-pause")?.actionId, second.actions.find((action) => action.targetId === "goal-a" && action.operation === "goal-pause")?.actionId);
    assert.equal(first.actions.some((action) => action.targetId === "task-b"), false);
});

test("Workspace projection suppresses automatic schedule while re-entry is user-owned", async () => {
    const gateway = {
        readTodo: async () => ({ tasks: [] }), listWaits: async () => [{ waitId: "question-a", createdByCtxId: "ctx-a", kind: "question", targetId: "question-a", status: "detached", detachedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:01:00.000Z", payload: { question: "Choose a path", choices: ["left", "right"], allowText: false } }], readGoal: async () => ({ goalId: "goal-a", revision: 1, status: "active", objective: "Goal", steps: [], continuationDue: true, continuationDueAt: "2026-10-01T00:02:00.000Z", continuationUncertain: false }),
        approval: { listPendingApprovals: async () => [], decideApproval: async () => ({}) }, hasActiveToolCalls: () => false,
        createWait: async () => ({}), detachWait: async () => ({}), consumeWait: async () => ({}), resolveWait: async () => ({}), waitForWait: async () => ({}),
        goalContinuation: async () => ({}), manageGoal: async () => undefined,
        readToolCalls: async () => [],
        readWorkspaceEvents: async () => ({ events: [], gap: false, lastSeq: 0 }),
    } as unknown as McpInteractionGateway;
    const { snapshot } = await readWorkspaceProjection(gateway, "alpha", "ctx-a", { reentry: { mode: "paused", pending: true, epoch: 4 } });
    assert.equal(snapshot.reentry.pending, true);
    assert.equal(snapshot.reentry.schedule, undefined);
    assert.equal(snapshot.reentry.delivery?.status, "paused");
    assert.equal(snapshot.presentation.primary?.kind, "question");
    assert.deepEqual(snapshot.presentation.primary?.kind === "question" ? snapshot.presentation.primary.input : undefined, { kind: "choice", choices: [{ id: "left", label: "left" }, { id: "right", label: "right" }], allowText: false });
    assert.deepEqual(snapshot.presentation.primary?.kind === "question" ? snapshot.presentation.primary.actions[0]?.input : undefined, { kind: "choice", choices: [{ id: "left", label: "left" }, { id: "right", label: "right" }] });
    const validateSnapshot = new AjvJsonSchemaValidator().getValidator(workspaceSnapshotOutputSchema as unknown as JsonSchemaType);
    assert.equal(validateSnapshot(snapshot).valid, true);
    const publicSnapshot = await readWorkspaceSnapshot(gateway, "alpha", "ctx-a", { reentry: { mode: "paused", pending: true, epoch: 4 } });
    assert.equal("snapshot" in (publicSnapshot as object), false);
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    gateway.listWaits = async () => [];
    gateway.readGoal = async () => goalSnapshot({ continuationDueAt: "2026-10-01T00:00:00.000Z" });
    const leased = await readWorkspaceProjection(gateway, "alpha", "ctx-a", { reentry: { mode: "automatic", pending: true, executionLeaseUntil: leaseUntil } });
    assert.equal(leased.snapshot.reentry.schedule?.readyAt, leaseUntil);
});

test("Todo contributor hides terminal tasks from work but retains them in model context", () => {
    const statuses = ["completed", "cancelled", "failed", "none"] as const;
    const result = contributeTodo(statuses.map((status, index) => ({ ctxId: "ctx-a", taskId: `terminal-${index}`, revision: 1, status, title: status, completed: 2, total: 2 } as TodoTaskSummary)), "ctx-a", "alpha", true);
    assert.deepEqual(result.items, []);
    assert.equal(result.modelTasks.length, statuses.length);
    assert.deepEqual(result.actions, []);
});

test("Todo contributor projects source completion counts", () => {
    const result = contributeTodo([{ ctxId: "ctx-a", taskId: "task-a", revision: 2, status: "in_progress", title: "Build", completed: 3, total: 7, updatedAt: "2026-10-02T00:00:00.000Z" }], "ctx-a", "alpha", true);
    assert.deepEqual(result.items[0]?.progress, { current: 3, total: 7 });
});

test("Goal contributor preserves terminal, blocked, progress, and recovery UI semantics", () => {
    const terminalStatuses = ["completed", "stopped"] as const;
    for (const status of terminalStatuses) {
        const result = contributeGoal(goalSnapshot({ status }), "ctx-a", "alpha");
        assert.equal(result.item, undefined);
        assert.deepEqual(result.actions, []);
    }
    const blocked = contributeGoal(goalSnapshot({ status: "blocked", note: "Waiting on input", steps: [{ id: "next", status: "pending", text: "Resume here", note: "Check first" }] }), "ctx-a", "alpha");
    assert.deepEqual(blocked.actions.map((action) => action.operation), ["goal-resume", "goal-stop"]);
    assert.equal(blocked.item?.current, "Resume here");
    assert.equal(blocked.item?.note, "Check first");
    assert.equal(blocked.item?.detail, "Reason: Waiting on input");
    assert.deepEqual(blocked.item?.progress, { current: 0, total: 1 });
    const recovered = contributeGoal(goalSnapshot({ autoContinueExhausted: true, continuationUncertain: true, steps: [{ id: "done", status: "skipped", text: "Skip" }, { id: "next", status: "pending", text: "Next" }] }), "ctx-a", "alpha");
    assert.equal(recovered.item?.badge, "Delivery uncertain");
    assert.match(recovered.item?.detail ?? "", /Automatic retry stopped/u);
    assert.match(recovered.item?.detail ?? "", /no-progress retry limit/u);
    assert.deepEqual(recovered.actions.map((action) => action.operation), ["goal-pause", "goal-stop", "goal-retry"]);
    assert.equal(recovered.item?.current, "Next");
    assert.deepEqual(recovered.item?.progress, { current: 1, total: 2 });
});

test("resolved uncertain Wait exposes dismiss action and exact choice action input", () => {
    const resolved = waitRecord({ status: "resolved", detachedAt: "2026-10-01T00:00:00.000Z", recoveryMessageAttemptedAt: "2026-10-01T00:01:00.000Z", recoveryMessageId: "message-a" });
    const choice = waitRecord({ waitId: "question-choice", kind: "question", status: "waiting", payload: { question: "Pick", choices: ["A", "B"], allowText: false } });
    const result = contributeWaits([resolved, choice], "ctx-a", "alpha", { answer: true, interrupt: true, dismissRecovery: true });
    assert.deepEqual(result.actions.map((action) => action.operation), ["wait-dismiss", "question-answer"]);
    assert.equal(result.actions[0]?.recoveryMessageId, "message-a");
    assert.equal(result.background[0]?.badge, "Delivery uncertain");
    assert.match(result.background[0]?.detail ?? "", /Automatic retry stopped/u);
    assert.deepEqual(result.questions[0]?.input, { kind: "choice", choices: [{ id: "A", label: "A" }, { id: "B", label: "B" }], allowText: false });
    assert.deepEqual(result.questions[0]?.actions[0]?.input, { kind: "choice", choices: [{ id: "A", label: "A" }, { id: "B", label: "B" }] });
});

test("Goal schedule uses future due, retry, and execution lease times and excludes stopped automatic resumes", () => {
    const goal = goalSnapshot({ continuationDue: false, continuationDueAt: "2099-01-01T00:00:00.000Z", continuationRetryAfter: "2099-02-01T00:00:00.000Z" });
    const retrySchedule = projectWorkspaceReentry({ mode: "automatic" }, [], goal, false).schedule;
    assert.deepEqual(retrySchedule, { readyAt: "2099-02-01T00:00:00.000Z", intent: "automatic", sourceId: "goal-a" });
    const schedule = projectWorkspaceReentry({ mode: "automatic", executionLeaseUntil: "2099-03-01T00:00:00.000Z" }, [], goal, false).schedule;
    assert.deepEqual(schedule, { readyAt: "2099-03-01T00:00:00.000Z", intent: "automatic", sourceId: "goal-a" });
    assert.equal(projectWorkspaceReentry({ mode: "automatic", executionLeaseUntil: "2099-03-01T00:00:00.000Z" }, [], goalSnapshot({ continuationDue: false, continuationDueAt: undefined as unknown as string }), false).schedule, undefined);
    assert.equal(projectWorkspaceReentry({ mode: "automatic" }, [], goalSnapshot({ continuationUncertain: true }), false).schedule, undefined);
    assert.equal(projectWorkspaceReentry({ mode: "automatic" }, [], goalSnapshot({ autoContinueExhausted: true }), false).schedule, undefined);
    assert.equal(projectWorkspaceReentry({ mode: "automatic" }, [], goalSnapshot({ status: "paused" }), false).schedule, undefined);
    assert.equal(projectWorkspaceReentry({ mode: "automatic" }, [], goalSnapshot({ steps: [] }), false).schedule, undefined);
    assert.equal(projectWorkspaceReentry({ mode: "automatic" }, [waitRecord({ status: "detached" })], goalSnapshot(), false).schedule, undefined);
});

test("Workspace snapshot reads events before the domain snapshot", async () => {
    let taskTitle = "old";
    const gateway = {
        readTodo: async () => ({ tasks: [{ ctxId: "ctx-a", taskId: "task-a", revision: 1, status: "in_progress", title: taskTitle, completed: 0, total: 1 }] }),
        listWaits: async () => [],
        createWait: async () => ({}), detachWait: async () => ({}), consumeWait: async () => ({}), resolveWait: async () => ({}), waitForWait: async () => ({}),
        approval: { listPendingApprovals: async () => [], decideApproval: async () => ({}) },
        readWorkspaceEvents: async () => { taskTitle = "new"; return { events: [], gap: false, lastSeq: 42 }; },
        readToolCalls: async () => [], hasActiveToolCalls: () => false,
    } as unknown as McpInteractionGateway;
    const result = await readWorkspaceProjection(gateway, "alpha", "ctx-a");
    assert.equal(result.snapshot.cursor, 42);
    assert.equal(result.snapshot.presentation.work[0]?.title, "new");
});

function goalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
    return {
        autoContinueExhausted: false, continuationCount: 0, continuationDue: true, continuationDueAt: "2099-01-01T00:00:00.000Z", continuationPending: false, continuationUncertain: false,
        createdAt: "2026-10-01T00:00:00.000Z", goalId: "goal-a", lastAgentActivityAt: "2026-10-01T00:00:00.000Z", lastProgressAt: "2026-10-01T00:00:00.000Z",
        objective: "Goal", revision: 1, status: "active", steps: [{ id: "next", status: "active", text: "Continue work" }], updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
    };
}

function waitRecord(overrides: Partial<WaitRecord> = {}): WaitRecord {
    return {
        createdByCtxId: "ctx-a", createdAt: "2026-10-01T00:00:00.000Z", kind: "tmux", targetId: "tmux-a", status: "detached", updatedAt: "2026-10-01T00:00:00.000Z", waitId: "wait-a", ...overrides,
    };
}
