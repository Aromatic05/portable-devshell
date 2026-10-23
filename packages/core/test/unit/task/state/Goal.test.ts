import assert from "node:assert/strict";
import test from "node:test";

import {
    GOAL_EXECUTION_LEASE_MS,
    GoalState,
} from "../../../../src/task/goal/storage/State.ts";

test("GoalState detects an abandoned active Goal after one minute", () => {
    assert.equal(GOAL_EXECUTION_LEASE_MS, 60_000);
});

test("GoalState holds a final objective until explicit finish and accepts legacy persisted steps", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    let ids = 0;
    const state = new GoalState({ goalId: () => `goal-${++ids}`, now: () => new Date(now).toISOString() });
    const initial = state.manage(state.emptyDocument(), {
        action: "start", objective: "Ship Workspace Goal mode",
    }, "ctx-goal");
    assert.equal(initial.result?.goalId, "goal-1");
    assert.equal(initial.result?.status, "active");
    assert.equal("steps" in (initial.result ?? {}), false);
    now += 1_000;
    const updated = state.manage(initial.document, {
        action: "update", note: "Changes recorded in persistent Memory",
    }, "ctx-goal");
    assert.equal(updated.result?.status, "active");
    const legacy = state.normalizeDocument({ version: 1, goals: [{
        ...updated.document.goals[0], steps: [
            { id: "work", text: "Old plan", status: "completed" },
        ],
    }] });
    assert.equal(state.read(legacy, "ctx-goal")?.status, "active");
    assert.equal("steps" in legacy.goals[0]!, false);
    const finished = state.manage(legacy, { action: "finish" }, "ctx-goal");
    assert.equal(finished.result?.status, "completed");
    assert.equal(finished.result?.continuationDue, false);
    assert.throws(() => state.manage(finished.document, { action: "finish" }, "ctx-goal"), /already completed/u);
    const next = state.manage(finished.document, { action: "start", objective: "Second goal" }, "ctx-goal");
    assert.equal(next.result?.goalId, "goal-2");
    assert.equal(state.manage(next.document, { action: "stop" }, "ctx-goal").result?.status, "stopped");
});

test("GoalState continuation claims are validated against agent activity and count only dispatched attempts", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-fixed",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Continue autonomously",

        },
        "ctx-goal",
    ).document;

    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);

    let continuation = state.continuation(
        document,
        {
            action: "claim",
            available: true,
            claimId: "claim-1",
        },
        "ctx-goal",
    );
    document = continuation.document;
    assert.equal(continuation.result.claimed, true);
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);

    now += 1_000;
    document = state.touch(document, "ctx-goal").document;
    continuation = state.continuation(
        document,
        {
            action: "validate",
            available: true,
            claimId: "claim-1",
        },
        "ctx-goal",
    );
    document = continuation.document;
    assert.equal(continuation.result.valid, false);
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);

    now += GOAL_EXECUTION_LEASE_MS + 1;
    continuation = state.continuation(
        document,
        {
            action: "claim",
            available: true,
            claimId: "claim-2",
        },
        "ctx-goal",
    );
    document = continuation.document;
    assert.equal(continuation.result.claimed, true);
    continuation = state.continuation(
        document,
        {
            action: "validate",
            available: true,
            claimId: "claim-2",
        },
        "ctx-goal",
    );
    document = continuation.document;
    assert.equal(continuation.result.valid, true);

    continuation = state.continuation(
        document,
        {
            action: "attempt",
            claimId: "claim-2",
        },
        "ctx-goal",
    );
    document = continuation.document;
    assert.equal(continuation.result.attempted, true);
    assert.equal(state.read(document, "ctx-goal")?.continuationUncertain, true);

    continuation = state.continuation(
        document,
        {
            accepted: true,
            action: "report",
            claimId: "claim-2",
        },
        "ctx-goal",
    );
    document = continuation.document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);

    now += GOAL_EXECUTION_LEASE_MS * 10;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);

    document = state.touch(document, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);
    now += GOAL_EXECUTION_LEASE_MS * 10;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);

    document = state.manage(
        document,
        {
            action: "update",
            note: "Keep working after durable progress",
        },
        "ctx-goal",
    ).document;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);
    continuation = state.continuation(
        document,
        {
            action: "claim",
            available: true,
            claimId: "claim-rejected",
        },
        "ctx-goal",
    );
    document = continuation.document;
    continuation = state.continuation(
        document,
        {
            accepted: false,
            action: "report",
            claimId: "claim-rejected",
        },
        "ctx-goal",
    );
    document = continuation.document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);

    document = state.manage(
        document,
        { action: "block", note: "Need user input" },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);
    document = state.manage(
        document,
        { action: "update", objective: "Still waiting for input" },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.status, "blocked");
    now += GOAL_EXECUTION_LEASE_MS * 2;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
});

test("GoalState retires an attempted continuation without stopping or progressing the Goal", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-fixed",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Keep Goal durable",

        },
        "ctx-goal",
    ).document;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    document = state.continuation(
        document,
        {
            action: "claim",
            available: true,
            claimId: "claim-retire",
        },
        "ctx-goal",
    ).document;
    document = state.continuation(
        document,
        {
            action: "attempt",
            claimId: "claim-retire",
        },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.continuationUncertain, true);

    const retired = state.continuation(
        document,
        {
            action: "retire",
            goalId: "goal-fixed",
        },
        "ctx-goal",
    );
    const goal = state.read(retired.document, "ctx-goal");
    assert.equal(retired.result.retired, true);
    assert.equal(goal?.status, "active");
    assert.equal(goal?.continuationPending, false);
    assert.equal(goal?.continuationUncertain, false);
    assert.equal(goal?.continuationCount, 0);

    const repeated = state.continuation(
        retired.document,
        {
            action: "retire",
            goalId: "goal-fixed",
        },
        "ctx-goal",
    );
    assert.equal(repeated.result.retired, true);
    assert.equal(state.read(repeated.document, "ctx-goal")?.status, "active");
});

test("GoalState user-initiated resume uses the durable continuation fence without waiting for inactivity", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-user-resume",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Resume immediately",

        },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);

    let transition = state.continuation(
        document,
        {
            action: "claim",
            available: true,
            claimId: "claim-user",
            goalId: "goal-user-resume",
            userInitiated: true,
        },
        "ctx-goal",
    );
    document = transition.document;
    assert.equal(transition.result.claimed, true);

    transition = state.continuation(
        document,
        {
            action: "attempt",
            claimId: "claim-user",
            goalId: "goal-user-resume",
            userInitiated: true,
        },
        "ctx-goal",
    );
    document = transition.document;
    assert.equal(state.read(document, "ctx-goal")?.continuationUncertain, true);

    now += GOAL_EXECUTION_LEASE_MS * 10;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);

    transition = state.continuation(
        document,
        {
            accepted: true,
            action: "report",
            claimId: "claim-user",
            goalId: "goal-user-resume",
            userInitiated: true,
        },
        "ctx-goal",
    );
    document = transition.document;
    assert.equal(state.read(document, "ctx-goal")?.continuationPending, false);
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);
});

test("GoalState continuation claim is fenced by stable goal identity", () => {
    const state = new GoalState({ goalId: () => "goal-current" });
    const started = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Current Goal",

        },
        "ctx-goal",
    );

    const stale = state.continuation(
        started.document,
        {
            action: "claim",
            available: true,
            claimId: "claim-stale",
            goalId: "goal-old",
            userInitiated: true,
        },
        "ctx-goal",
    );
    assert.equal(stale.result.claimed, false);
    assert.equal(
        (stale.result.goal as { goalId?: string } | undefined)?.goalId,
        "goal-current",
    );
    assert.equal(
        state.read(stale.document, "ctx-goal")?.continuationPending,
        false,
    );
});

test("GoalState separates agent activity from durable Goal progress", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-progress",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Track real progress",

        },
        "ctx-goal",
    ).document;

    now += GOAL_EXECUTION_LEASE_MS + 1;
    let continuation = state.continuation(
        document,
        { action: "claim", available: true, claimId: "claim-1" },
        "ctx-goal",
    );
    document = continuation.document;
    continuation = state.continuation(
        document,
        { action: "attempt", claimId: "claim-1" },
        "ctx-goal",
    );
    document = continuation.document;
    continuation = state.continuation(
        document,
        { accepted: true, action: "report", claimId: "claim-1" },
        "ctx-goal",
    );
    document = continuation.document;
    const progressAt = state.read(document, "ctx-goal")?.lastProgressAt;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);

    now += 1_000;
    document = state.touch(document, "ctx-goal").document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 1);
    assert.equal(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);
    now += GOAL_EXECUTION_LEASE_MS * 10;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);

    now += 1_000;
    document = state.manage(
        document,
        { action: "update", note: "Status only" },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);
    assert.notEqual(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);

    now += 1_000;
    document = state.manage(
        document,
        { action: "update", note: "Meaningful work completed" },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.continuationCount, 0);
    assert.notEqual(
        state.read(document, "ctx-goal")?.lastProgressAt,
        progressAt,
    );
});

test("GoalState observation-only activity does not extend the execution lease", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-observation-lease",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Do real work",

        },
        "ctx-goal",
    ).document;

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
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Track evidence",

        },
        "ctx-goal",
    ).document;
    const startedAt = state.read(document, "ctx-goal")!.lastAgentActivityAt;

    now += GOAL_EXECUTION_LEASE_MS + 1;
    let transition = state.continuation(
        document,
        { action: "claim", available: true, claimId: "claim-1" },
        "ctx-goal",
    );
    document = transition.document;
    transition = state.continuation(
        document,
        { action: "attempt", claimId: "claim-1" },
        "ctx-goal",
    );
    document = transition.document;
    transition = state.continuation(
        document,
        { accepted: true, action: "report", claimId: "claim-1" },
        "ctx-goal",
    );
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
    transition = state.continuation(
        document,
        { action: "claim", available: true, claimId: "claim-2" },
        "ctx-goal",
    );
    document = transition.document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(transition.result.claimed, false);
    assert.equal(snapshot.noActionStreak, 0);

    now += 1_000;
    document = state.touch(document, "ctx-goal", "mutation").document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.noActionStreak, 0);
    assert.equal(snapshot.lastExecutionAt, new Date(now).toISOString());
    assert.equal(snapshot.progressEpoch, 1);
    assert.equal(snapshot.lastProgressAt, new Date(now).toISOString());

    now += GOAL_EXECUTION_LEASE_MS + 1;
    transition = state.continuation(
        document,
        { action: "claim", available: true, claimId: "claim-3" },
        "ctx-goal",
    );
    document = transition.document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(transition.result.claimed, true);
    assert.equal(snapshot.continuationPending, true);
    assert.equal(snapshot.noActionStreak, 0);
    assert.equal(snapshot.stagnationStreak, 0);

    now += 1_000;
    document = state.manage(
        document,
        { action: "update", note: "Meaningful work completed" },
        "ctx-goal",
    ).document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.noActionStreak, 0);
    assert.equal(snapshot.stagnationStreak, 0);
    assert.equal(snapshot.lastProgressAt, new Date(now).toISOString());
    assert.equal(snapshot.progressEpoch, 2);
});

test("GoalState records an external wait wake as re-entry without faking Agent activity", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-wait-wake",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Resume after wait",

        },
        "ctx-goal",
    ).document;
    const activityAt = state.read(document, "ctx-goal")!.lastAgentActivityAt;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);

    document = state.reentry(document, "ctx-goal").document;
    let snapshot = state.read(document, "ctx-goal")!;
    assert.equal(snapshot.lastAgentActivityAt, activityAt);
    assert.equal(snapshot.lastReentryAt, new Date(now).toISOString());
    assert.equal(snapshot.continuationDue, false);

    now += GOAL_EXECUTION_LEASE_MS + 1;
    const claim = state.continuation(
        document,
        { action: "claim", available: true, claimId: "claim-after-wait" },
        "ctx-goal",
    );
    document = claim.document;
    snapshot = state.read(document, "ctx-goal")!;
    assert.equal(claim.result.claimed, false);
    assert.equal(snapshot.noActionStreak, 0);
});

test("GoalState re-arms from progress epoch even when progress and re-entry share a timestamp", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-progress-epoch",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Track causal progress",

        },
        "ctx-goal",
    ).document;

    now += GOAL_EXECUTION_LEASE_MS + 1;
    let continuation = state.continuation(
        document,
        { action: "claim", available: true, claimId: "claim-epoch" },
        "ctx-goal",
    );
    document = continuation.document;
    continuation = state.continuation(
        document,
        { action: "attempt", claimId: "claim-epoch" },
        "ctx-goal",
    );
    document = continuation.document;
    continuation = state.continuation(
        document,
        { accepted: true, action: "report", claimId: "claim-epoch" },
        "ctx-goal",
    );
    document = continuation.document;

    document = state.manage(
        document,
        {
            action: "update",
            note: "Do work with real progress",
        },
        "ctx-goal",
    ).document;
    const sameTimestamp = state.read(document, "ctx-goal")!;
    assert.equal(sameTimestamp.lastProgressAt, sameTimestamp.lastReentryAt);

    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);
});

test("GoalState user pause fences continuation until an explicit user resume", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-paused",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Pause safely",

        },
        "ctx-goal",
    ).document;
    const progressAt = state.read(document, "ctx-goal")?.lastProgressAt;
    document = state.manage(
        document,
        { action: "pause", userControl: true },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.status, "paused");
    assert.equal(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);
    now += GOAL_EXECUTION_LEASE_MS * 3;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
    assert.throws(
        () => state.manage(document, { action: "resume" }, "ctx-goal"),
        /paused Workspace Goal requires an explicit user resume/u,
    );
    document = state.manage(
        document,
        { action: "resume", userControl: true },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.status, "active");
    assert.equal(state.read(document, "ctx-goal")?.lastProgressAt, progressAt);
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);
});

test("GoalState fences stale Workspace UI actions by goal id and revision", () => {
    const state = new GoalState({ goalId: () => "goal-current" });
    const started = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Protected goal",

        },
        "ctx-goal",
    );
    const revision = started.result?.revision ?? 0;

    assert.throws(
        () =>
            state.manage(
                started.document,
                {
                    action: "stop",
                    expectedGoalId: "goal-stale",
                    expectedRevision: revision,
                },
                "ctx-goal",
            ),
        /changed from goal-stale/u,
    );
    assert.throws(
        () =>
            state.manage(
                started.document,
                {
                    action: "stop",
                    expectedGoalId: "goal-current",
                    expectedRevision: revision + 1,
                },
                "ctx-goal",
            ),
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
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Continue safely",

        },
        "ctx-goal",
    ).document;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    let transition = state.continuation(
        document,
        { action: "claim", available: true, claimId: "claim-1" },
        "ctx-goal",
    );
    document = transition.document;
    transition = state.continuation(
        document,
        { action: "validate", available: true, claimId: "claim-1" },
        "ctx-goal",
    );
    document = transition.document;
    transition = state.continuation(
        document,
        { action: "attempt", claimId: "claim-1" },
        "ctx-goal",
    );
    document = transition.document;

    now += 60 * 60 * 1_000;
    const snapshot = state.read(document, "ctx-goal");
    assert.equal(snapshot?.continuationUncertain, true);
    assert.equal(snapshot?.continuationPending, true);
    assert.equal(snapshot?.continuationDue, false);
    document = state.continuation(
        document,
        { accepted: false, action: "report", claimId: "claim-1" },
        "ctx-goal",
    ).document;
    assert.equal(
        state.read(document, "ctx-goal")?.continuationUncertain,
        false,
    );
    assert.equal(state.read(document, "ctx-goal")?.continuationPending, false);

    const observed = state.touch(document, "ctx-goal");
    assert.equal(observed.result?.continuationUncertain, false);
    assert.equal(observed.result?.continuationPending, false);
    assert.equal(observed.result?.continuationDue, false);
});

test("GoalState treats Agent activity after dispatch attempt as accepted delivery evidence", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-fast-activity",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Settle a fast accepted wake",

        },
        "ctx-goal",
    ).document;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    let transition = state.continuation(
        document,
        { action: "claim", available: true, claimId: "claim-fast" },
        "ctx-goal",
    );
    document = transition.document;
    transition = state.continuation(
        document,
        { action: "attempt", claimId: "claim-fast" },
        "ctx-goal",
    );
    document = transition.document;

    now += 1;
    const observed = state.touch(document, "ctx-goal", "execution");
    document = observed.document;
    assert.equal(observed.result?.continuationUncertain, false);
    assert.equal(observed.result?.continuationPending, false);
    assert.equal(observed.result?.continuationCount, 1);
    assert.equal(observed.result?.lastReentryAt, new Date(now).toISOString());

    now += GOAL_EXECUTION_LEASE_MS * 10;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, false);
});

test("GoalState accepted receipt covers only the progress epoch visible to that delivery", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-causal-receipt",
        now: () => new Date(now).toISOString(),
    });
    let document = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Keep later progress visible",

        },
        "ctx-goal",
    ).document;
    document = state.manage(
        document,
        {
            action: "update",
            note: "New progress after the old delivery was prepared",
        },
        "ctx-goal",
    ).document;
    assert.equal(state.read(document, "ctx-goal")?.progressEpoch, 1);

    document = state.reentry(document, "ctx-goal", 0).document;
    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, "ctx-goal")?.continuationDue, true);
    assert.throws(
        () => state.reentry(document, "ctx-goal", 2),
        /progress epoch 2 is invalid for current epoch 1/u,
    );
});

test("GoalState never exhausts an actionable Goal solely because wake attempts accumulated", () => {
    let now = Date.parse("2026-08-20T12:00:00.000Z");
    const state = new GoalState({
        goalId: () => "goal-finalize",
        now: () => new Date(now).toISOString(),
    });
    const transition = state.manage(
        state.emptyDocument(),
        {
            action: "start",
            objective: "Finalize explicitly",

        },
        "ctx-goal",
    );
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
        document = state.manage(
            document,
            {
                action: "start",
                objective: ctxId,

            },
            ctxId,
        ).document;
        now += 1_000;
        document = state.manage(document, { action: "stop" }, ctxId).document;
        now += 1_000;
    }
    document = state.manage(
        document,
        {
            action: "start",
            objective: "live",

        },
        "ctx-live",
    ).document;

    const compacted = state.compact(document, 1);
    assert.deepEqual(
        compacted.goals.map((goal) => goal.createdByCtxId),
        ["ctx-new", "ctx-live"],
    );
});
