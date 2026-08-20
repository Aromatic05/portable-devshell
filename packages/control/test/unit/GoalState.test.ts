import assert from "node:assert/strict";
import test from "node:test";

import { GOAL_EXECUTION_LEASE_MS, GoalState } from "../../src/instance/goal/GoalState.ts";

test("GoalState manages start, step updates, finish, and stop", () => {
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
    document = state.manage(document, {
        action: "update",
        status: "completed",
        stepId: "verify",
    }, "ctx-goal").document;
    now += 1_000;
    transition = state.manage(document, { action: "finish" }, "ctx-goal");
    document = transition.document;
    assert.equal(transition.result?.status, "completed");

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
        accepted: true,
        action: "report",
        claimId: "claim-2",
    }, "ctx-goal");
    document = continuation.document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);

    document = state.manage(document, { action: "block", note: "Need user input" }, "ctx-goal").document;
    now += GOAL_EXECUTION_LEASE_MS * 2;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
});
