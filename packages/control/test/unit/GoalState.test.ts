import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_EXECUTION_LEASE_MS, GoalState } from "../../src/instance/goal/GoalState.ts";

test("GoalState detects an abandoned active Goal after one minute", () => {
    assert.equal(GOAL_EXECUTION_LEASE_MS, 60_000);
});

test("GoalState completes atomically when the final step becomes terminal", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    let ids = 0;
    const state = new GoalState({
        goalId: () => `goal-${++ids}`,
        now: () => new Date(now).toISOString(),
    });

    let transition = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Ship Workspace Goal mode",
        steps: [
            { id: "implement", status: "active", text: "Implement Goal runtime" },
            { id: "verify", text: "Verify Workspace behavior" },
        ],
    }, "ctx-goal");
    let document = transition.document;
    assert.equal(transition.result?.goalId, "goal-1");
    assert.equal(transition.result?.status, "active");

    now += 1_000;
    document = state.manage(document, {
        action: "update",
        status: "completed",
        stepId: "implement",
    }, "ctx-goal").document;
    now += 1_000;
    document = state.manage(document, {
        action: "update",
        status: "active",
        stepId: "verify",
    }, "ctx-goal").document;
    now += 1_000;
    transition = state.manage(document, {
        action: "update",
        status: "completed",
        stepId: "verify",
    }, "ctx-goal");
    document = transition.document;
    assert.equal(transition.result?.status, "completed");
    assert.equal(transition.result?.continuationDue, false);
    assert.throws(
        () => state.manage(document, { action: "finish" }, "ctx-goal"),
        /already completed/u,
    );

    now += 1_000;
    transition = state.manage(document, {
        action: "start",
        objective: "Second goal",
        steps: [{ id: "work", text: "Do the work" }],
    }, "ctx-goal");
    document = transition.document;
    assert.equal(transition.result?.goalId, "goal-2");
    transition = state.manage(document, { action: "stop" }, "ctx-goal");
    assert.equal(transition.result?.status, "stopped");
});

test("GoalState normalizes legacy active Goals with only terminal steps as completed", () => {
    const state = new GoalState({ now: () => "2026-08-20T12:00:00.000Z" });
    const normalized = state.normalizeDocument({
        goals: [{
            continuationCount: 2,
            continuationPending: false,
            createdAt: "2026-08-20T11:00:00.000Z",
            createdByCtxId: "ctx-legacy",
            goalId: "goal-legacy",
            lastAgentActivityAt: "2026-08-20T11:01:00.000Z",
            lastProgressAt: "2026-08-20T11:01:00.000Z",
            noActionStreak: 2,
            objective: "Legacy terminal Goal",
            revision: 7,
            stagnationStreak: 1,
            status: "active",
            steps: [{ id: "done", status: "completed", text: "Done" }],
            updatedAt: "2026-08-20T11:01:00.000Z",
        }],
        version: 1,
    });

    const goal = state.read(normalized, "ctx-legacy");
    assert.equal(goal?.status, "completed");
    assert.equal(goal?.continuationDue, false);
    assert.equal(goal?.continuationCount, 0);
});

test("GoalState continuation claims are validated against agent activity and count only dispatched attempts", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-fixed",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Continue autonomously",
        steps: [{ id: "work", status: "active", text: "Keep working" }],
    }, "ctx-goal").document;

    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);

    let continuation = state.continuation(document, {
        action: "claim",
        available: true,
        claimId: "claim-1",
    }, "ctx-goal");
    document = continuation.document;
    assert.equal(continuation.result.claimed, true);
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);

    now += 1_000;
    document = state.touch(document, "ctx-goal").document;
    continuation = state.continuation(document, {
        action: "validate",
        available: true,
        claimId: "claim-1",
    }, "ctx-goal");
    document = continuation.document;
    assert.equal(continuation.result.valid, false);
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);

    now += GOAL_EXECUTION_LEASE_MS + 1;
    continuation = state.continuation(document, {
        action: "claim",
        available: true,
        claimId: "claim-2",
    }, "ctx-goal");
    document = continuation.document;
    assert.equal(continuation.result.claimed, true);
    continuation = state.continuation(document, {
        action: "validate",
        available: true,
        claimId: "claim-2",
    }, "ctx-goal");
    document = continuation.document;
    assert.equal(continuation.result.valid, true);

    continuation = state.continuation(document, {
        action: "attempt",
        claimId: "claim-2",
    }, "ctx-goal");
    document = continuation.document;
    assert.equal(continuation.result.attempted, true);
    assert.equal(state.read(document, "ctx-goal")?.continuationUncertain, true);

    continuation = state.continuation(document, {
        accepted: true,
        action: "report",
        claimId: "claim-2",
    }, "ctx-goal");
    document = continuation.document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);

    now += 1_000;
    document = state.touch(document, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);

    now += GOAL_EXECUTION_LEASE_MS + 1;
    continuation = state.continuation(document, {
        action: "claim",
        available: true,
        claimId: "claim-rejected",
    }, "ctx-goal");
    document = continuation.document;
    continuation = state.continuation(document, {
        accepted: false,
        action: "report",
        claimId: "claim-rejected",
    }, "ctx-goal");
    document = continuation.document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);

    document = state.manage(document, { action: "block", note: "Need user input" }, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);
    document = state.manage(document, { action: "update", objective: "Still waiting for input" }, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.status, "blocked");
    now += GOAL_EXECUTION_LEASE_MS * 2;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
});

test("GoalState separates agent activity from durable Goal progress", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-progress",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Track real progress",
        steps: [{ id: "work", status: "active", text: "Work" }],
    }, "ctx-goal").document;

    now += GOAL_EXECUTION_LEASE_MS + 1;
    let continuation = state.continuation(document, { action: "claim", available: true, claimId: "claim-1" }, "ctx-goal");
    document = continuation.document;
    continuation = state.continuation(document, { action: "attempt", claimId: "claim-1" }, "ctx-goal");
    document = continuation.document;
    continuation = state.continuation(document, { accepted: true, action: "report", claimId: "claim-1" }, "ctx-goal");
    document = continuation.document;
    const progressAt = state.read(document, "ctx-goal")?.lastProgressAt;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);

    now += 1_000;
    document = state.touch(document, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);
    assert.equal(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);

    now += 1_000;
    document = state.manage(document, { action: "update", note: "Status only" }, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);
    assert.equal(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);

    now += 1_000;
    document = state.manage(document, { action: "update", status: "completed", stepId: "work" }, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);
    assert.notEqual(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);
});


test("GoalState observation-only activity does not extend the execution lease", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({ goalId: () => "goal-observation-lease", now: () => new Date(now).toISOString() });
    let document = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Do real work",
        steps: [{ id: "work", status: "active", text: "Modify something" }],
    }, "ctx-goal").document;

    now += GOAL_EXECUTION_LEASE_MS - 5_000;
    document = state.touch(document, "ctx-goal", "observation").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
    now += 5_001;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);
});

test("GoalState distinguishes observation, execution, re-entry, and durable progress", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-evidence",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Track evidence",
        steps: [{ id: "work", status: "active", text: "Do work" }],
    }, "ctx-goal").document;
    const startedAt = state.read(document, "ctx-goal")!.lastAgentActivityAt;

    now += GOAL_EXECUTION_LEASE_MS + 1;
    let transition = state.continuation(document, { action: "claim", available: true, claimId: "claim-1" }, "ctx-goal");
    document = transition.document;
    transition = state.continuation(document, { action: "attempt", claimId: "claim-1" }, "ctx-goal");
    document = transition.document;
    transition = state.continuation(document, { accepted: true, action: "report", claimId: "claim-1" }, "ctx-goal");
    document = transition.document;
    let snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.lastAgentActivityAt, startedAt);
    assert.equal(snapshot.lastReentryAt, new Date(now).toISOString());
    assert.equal(snapshot.noActionStreak, 0);
    assert.equal(snapshot.continuationDue, false);

    now += 1_000;
    document = state.touch(document, "ctx-goal", "observation").document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.lastExecutionAt, undefined);
    assert.equal(snapshot.noActionStreak, 0);

    now += GOAL_EXECUTION_LEASE_MS + 1;
    transition = state.continuation(document, { action: "claim", available: true, claimId: "claim-2" }, "ctx-goal");
    document = transition.document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.noActionStreak, 1);
    transition = state.continuation(document, { action: "attempt", claimId: "claim-2" }, "ctx-goal");
    document = transition.document;
    transition = state.continuation(document, { accepted: true, action: "report", claimId: "claim-2" }, "ctx-goal");
    document = transition.document;

    now += 1_000;
    document = state.touch(document, "ctx-goal", "mutation").document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.noActionStreak, 0);
    assert.equal(snapshot.lastExecutionAt, new Date(now).toISOString());

    now += GOAL_EXECUTION_LEASE_MS + 1;
    transition = state.continuation(document, { action: "claim", available: true, claimId: "claim-3" }, "ctx-goal");
    document = transition.document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.noActionStreak, 0);
    assert.equal(snapshot.stagnationStreak, 1);

    now += 1_000;
    document = state.manage(document, { action: "update", status: "completed", stepId: "work" }, "ctx-goal").document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.noActionStreak, 0);
    assert.equal(snapshot.stagnationStreak, 0);
    assert.equal(snapshot.lastProgressAt, new Date(now).toISOString());
});

test("GoalState records an external wait wake as re-entry without faking Agent activity", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({ goalId: () => "goal-wait-wake", now: () => new Date(now).toISOString() });
    let document = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Resume after wait",
        steps: [{ id: "work", status: "active", text: "Use wait result" }],
    }, "ctx-goal").document;
    const activityAt = state.read(document, "ctx-goal")!.lastAgentActivityAt;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);

    document = state.reentry(document, "ctx-goal").document;
    let snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.lastAgentActivityAt, activityAt);
    assert.equal(snapshot.lastReentryAt, new Date(now).toISOString());
    assert.equal(snapshot.continuationDue, false);

    now += GOAL_EXECUTION_LEASE_MS + 1;
    document = state.continuation(document, { action: "claim", available: true, claimId: "claim-after-wait" }, "ctx-goal").document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.noActionStreak, 1);
});

test("GoalState user pause fences continuation until an explicit user resume", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-paused",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Pause safely",
        steps: [{ id: "work", status: "active", text: "Do work" }],
    }, "ctx-goal").document;
    const progressAt = state.read(document, "ctx-goal")?.lastProgressAt;
    document = state.manage(document, { action: "pause", userControl: true }, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.status, "paused");
    assert.equal(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);
    now += GOAL_EXECUTION_LEASE_MS * 3;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
    assert.throws(
        () => state.manage(document, { action: "resume" }, "ctx-goal"),
        /paused Workspace Goal requires an explicit user resume/u,
    );
    document = state.manage(document, { action: "resume", userControl: true }, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.status, "active");
    assert.equal(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);
});

test("GoalState fences stale Workspace UI actions by goal id and revision", () => {
    const state = new GoalState({ goalId: () => "goal-current" });
    const started = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Protected goal",
        steps: [{ id: "work", text: "Work" }],
    }, "ctx-goal");
    const revision = started.result?.revision ?? 0;

    assert.throws(
        () => state.manage(started.document, {
            action: "stop",
            expectedGoalId: "goal-stale",
            expectedRevision: revision,
        }, "ctx-goal"),
        /changed from goal-stale/u,
    );
    assert.throws(
        () => state.manage(started.document, {
            action: "stop",
            expectedGoalId: "goal-current",
            expectedRevision: revision + 1,
        }, "ctx-goal"),
        /changed from revision/u,
    );
    assert.equal(state.read(started.document, "ctx-goal")?.status, "active");
});

test("GoalState clears ambiguous delivery after definitive Host rejection or observed agent activity", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-fixed",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Continue safely",
        steps: [{ id: "work", status: "active", text: "Work" }],
    }, "ctx-goal").document;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    let transition = state.continuation(document, { action: "claim", available: true, claimId: "claim-1" }, "ctx-goal");
    document = transition.document;
    transition = state.continuation(document, { action: "validate", available: true, claimId: "claim-1" }, "ctx-goal");
    document = transition.document;
    transition = state.continuation(document, { action: "attempt", claimId: "claim-1" }, "ctx-goal");
    document = transition.document;

    now += 60 * 60 * 1_000;
    const snapshot = state.read(document, "ctx-goal");
    assert.equal(snapshot?.continuationUncertain, true);
    assert.equal(snapshot?.continuationPending, true);
    assert.equal(snapshot?.continuationDue, false);
    document = state.continuation(document, { accepted: false, action: "report", claimId: "claim-1" }, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationUncertain, false);
    assert.equal(state.read(document, "ctx-goal")?.continuationPending, false);

    const observed = state.touch(document, "ctx-goal");
    assert.equal(observed.result?.continuationUncertain, false);
    assert.equal(observed.result?.continuationPending, false);
    assert.equal(observed.result?.continuationDue, false);
});

test("GoalState never exhausts an actionable Goal solely because wake attempts accumulated", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-finalize",
        now: () => new Date(now).toISOString(),
    });
    const transition = state.manage(state.emptyDocument(), {
        action: "start",
        objective: "Finalize explicitly",
        steps: [{ id: "done", status: "active", text: "Done" }],
    }, "ctx-goal");
    transition.document.goals[0]!.continuationCount = 10;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    const snapshot = state.read(transition.document, "ctx-goal");
    assert.equal(snapshot?.autoContinueExhausted, false);
    assert.equal(snapshot?.continuationDue, true);
});

test("GoalState bounds terminal history without removing live Goals", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    let ids = 0;
    const state = new GoalState({
        goalId: () => `goal-${++ids}`,
        now: () => new Date(now).toISOString(),
    });
    let document = state.emptyDocument();

    for (const ctxId of ["ctx-old", "ctx-new"]) {
        document = state.manage(document, {
            action: "start",
            objective: ctxId,
            steps: [{ id: "work", text: "Work" }],
        }, ctxId).document;
        now += 1_000;
        document = state.manage(document, { action: "stop" }, ctxId).document;
        now += 1_000;
    }
    document = state.manage(document, {
        action: "start",
        objective: "live",
        steps: [{ id: "work", text: "Work" }],
    }, "ctx-live").document;

    const compacted = state.compact(document, 1);
    assert.deepEqual(compacted.goals.map((goal) => goal.createdByCtxId), ["ctx-new", "ctx-live"]);
});
