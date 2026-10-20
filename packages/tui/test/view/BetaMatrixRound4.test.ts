import assert from "node:assert/strict";
import test from "node:test";
import { asInstanceName } from "@portable-devshell/shared";
import { deferred, renderRound4Overlay, round4Tui } from "../support/Round4Harness.ts";

// Reentrant dispatch uses microtask barriers and deferred futures, never sleeps.
test("round4: rendered Delete confirmation serializes repeated accept and unlocks after exact error", async () => {
    const pending = deferred<void>(); const entered = deferred<void>(); const calls: unknown[] = [];
    const harness = round4Tui({ onInstanceDangerAction: async (...args) => {
        calls.push(args); entered.resolve(); await pending.promise;
    } });
    await harness.confirm();
    const first = harness.dispatcher.dispatch({ type: "confirm.accept" }); await entered.promise;
    await harness.dispatcher.dispatch({ type: "confirm.accept" });
    await harness.dispatcher.dispatch({ type: "confirm.cancel" });
    assert.equal(harness.top()?.kind, "confirmation");
    assert.equal((harness.top() as { busy: boolean }).busy, true);
    assert.match(await renderRound4Overlay(harness), /Working/u);
    assert.deepEqual(calls, [["delete", "alpha"]]);
    pending.reject(new Error("Delete alpha refused: active checkpoint 42")); await first;
    const text = await renderRound4Overlay(harness);
    assert.match(text, /Delete alpha refused: active checkpoint 42/u);
    assert.equal((harness.top() as { busy: boolean }).busy, false);
    await harness.dispatcher.dispatch({ type: "confirm.cancel" });
    assert.equal(harness.top(), undefined);
});

test("round4: Delete approval stays pinned to reviewed instance while selected instance changes", async () => {
    const pending = deferred<void>(); const entered = deferred<void>(); const calls: unknown[] = [];
    const harness = round4Tui({ onInstanceDangerAction: async (...args) => {
        calls.push(args); entered.resolve(); await pending.promise;
    } });
    await harness.confirm();
    harness.store.setSelectedInstance("beta");
    assert.match(await renderRound4Overlay(harness), /Delete alpha/u);
    const accepted = harness.dispatcher.dispatch({ type: "confirm.accept" }); await entered.promise;
    assert.deepEqual(calls, [["delete", "alpha"]]);
    pending.resolve(); await accepted;
    assert.equal(harness.top(), undefined);
    assert.equal(harness.store.getState().ui.selectedInstance, "beta");
});

test("round4: failing Todo delete retains exact failure and a subsequent retry closes confirmation", async () => {
    const calls: unknown[] = [];
    const attempts = [async () => { throw new Error("Task task-a locked at revision 7"); }, async () => undefined];
    const harness = round4Tui({ onTodoDelete: async (...args) => {
        calls.push(args); const attempt = attempts.shift(); assert.ok(attempt); await attempt();
    } });
    await harness.confirm("alpha", { type: "todo.delete", instance: "alpha", taskId: "task-a" });
    await harness.dispatcher.dispatch({ type: "confirm.accept" });
    assert.match(await renderRound4Overlay(harness), /Task task-a locked at revision 7/u);
    await harness.dispatcher.dispatch({ type: "confirm.accept" });
    assert.deepEqual(calls, [["alpha", "task-a"], ["alpha", "task-a"]]);
    assert.equal(harness.top(), undefined);
});

test("round4: rendered approval decision failure leaves review available after registry refresh", async () => {
    const pending = deferred<void>(); const entered = deferred<void>();
    const harness = round4Tui({ onApprovalDecision: async () => { entered.resolve(); await pending.promise; } });
    harness.domains.setApprovals("alpha", [{ approvalId: "approval-a", callId: "call-a", instance: asInstanceName("alpha"),
        ctxId: "ctx-old", toolName: "bash_run", inputSummary: "deploy-alpha", reason: "Review deploy", riskLevel: "high",
        source: "mcp", status: "pending", createdAt: "2026-10-20T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" }]);
    await harness.dispatcher.dispatch({ type: "approval.open", instance: "alpha", approvalId: "approval-a" });
    harness.store.replaceTopOverlay({ kind: "approval", instance: "alpha", approvalId: "approval-a", selectedAction: "approve" });
    harness.store.setFocusScope("approvalDetail");
    await harness.dispatcher.dispatch({ type: "focus.activate" });
    await harness.dispatcher.dispatch({ type: "confirm.focus", button: "confirm" });
    const accepted = harness.dispatcher.dispatch({ type: "confirm.accept" }); await entered.promise;
    harness.domains.setContexts([]); harness.store.setSelectedInstance("beta");
    pending.reject(new Error("Approval policy rejected revision 11")); await accepted;
    assert.match(await renderRound4Overlay(harness), /Approval policy rejected revision 11/u);
    await harness.dispatcher.dispatch({ type: "confirm.cancel" });
    assert.match(await renderRound4Overlay(harness), /deploy-alpha/u);
    assert.equal(harness.top()?.kind, "approval");
});

test("round4: canceling an idle Delete confirmation never invokes the destructive operation", async () => {
    const calls: unknown[] = [];
    const harness = round4Tui({ onInstanceDangerAction: async (...args) => { calls.push(args); } });
    await harness.confirm();
    await harness.dispatcher.dispatch({ type: "confirm.focus", button: "cancel" });
    await harness.dispatcher.dispatch({ type: "confirm.accept" });
    assert.equal(harness.top(), undefined); assert.deepEqual(calls, []);
});

test("round4: rendered TUI Goal consumes durable authoritative revisions from framed stream", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const { startRound4Peer, round4Goal } = await import("../../../web/test/support/Round4Harness.ts");
    const { GoalViewModel, createTaskTransport } = await import("@portable-devshell/shared");
    const { renderRound4Screen } = await import("../support/Round4Harness.ts");
    const directory = await mkdtemp(join(tmpdir(), "round4-tui-goal-"));
    const peer = await startRound4Peer(join(directory, "goals.sqlite"));
    const goals = new GoalViewModel({ refreshDelayMs: 0, transport: (instance) => createTaskTransport(peer.endpoint, instance) });
    try {
        const harness = round4Tui();
        Object.assign(harness.domains.domains, { goals });
        harness.store.setSelectedPage("todo");
        await peer.put("alpha", "goals", { goals: [round4Goal(7)], lastSeq: 0 });
        await goals.load("alpha");
        const box = harness.model().boxes.find((candidate) => candidate.id === "todo-goal:goal-alpha");
        assert.ok(box); harness.store.toggleExpanded(box.expandedKey);
        assert.match(await renderRound4Screen(harness), /Revision.*7/u);
        const changed = new Promise<void>((resolve) => {
            const unsubscribe = goals.subscribe(() => {
                if (goals.state.instances.alpha?.goals[0]?.revision !== 8) return;
                unsubscribe(); resolve();
            });
        });
        await peer.put("alpha", "goals", { goals: [round4Goal(8, "completed")], lastSeq: 1 },
            { instanceName: "alpha", seq: 1, type: "goal.updated", at: "2026-10-20T00:01:00Z" });
        await changed;
        const text = await renderRound4Screen(harness);
        assert.match(text, /Revision.*8/u); assert.match(text, /completed/u); assert.match(text, /1\/1 steps/u);
        assert.equal(harness.model().boxes.find((candidate) => candidate.id === box.id)?.disabled, undefined);
    } finally { goals.close(); await peer.close(); await rm(directory, { recursive: true, force: true }); }
});

test("round4: late alpha Goal refresh does not replace selected beta authoritative render", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const { GoalViewModel, createTaskTransport } = await import("@portable-devshell/shared");
    const { startRound4Peer, round4Goal } = await import("../../../web/test/support/Round4Harness.ts");
    const { renderRound4Screen } = await import("../support/Round4Harness.ts");
    const directory = await mkdtemp(join(tmpdir(), "round4-tui-switch-"));
    const peer = await startRound4Peer(join(directory, "goals.sqlite"));
    const pending = deferred<void>(); const entered = deferred<void>();
    const goals = new GoalViewModel({ transport: (instance) => {
        const transport = createTaskTransport(peer.endpoint, instance);
        return { ...transport, getGoals: async () => {
            const snapshot = await transport.getGoals();
            if (instance === "alpha") { entered.resolve(); await pending.promise; }
            return snapshot;
        } };
    } });
    try {
        await peer.put("alpha", "goals", { goals: [round4Goal(9)], lastSeq: 1 });
        await peer.put("beta", "goals", { goals: [{ ...round4Goal(12), objective: "Review beta checkpoint" }], lastSeq: 0 });
        const harness = round4Tui(); Object.assign(harness.domains.domains, { goals });
        harness.store.setSelectedPage("todo");
        const alpha = goals.load("alpha"); await entered.promise;
        harness.store.setSelectedInstance("beta"); await goals.load("beta");
        assert.match(await renderRound4Screen(harness), /Review beta checkpoint/u);
        pending.resolve(); await alpha;
        const text = await renderRound4Screen(harness);
        assert.match(text, /Review beta checkpoint/u); assert.doesNotMatch(text, /Verify round4 persistence/u);
        assert.equal(harness.store.getState().ui.selectedInstance, "beta");
        assert.equal(goals.state.instances.alpha?.goals[0]?.revision, 9);
        assert.equal(goals.state.instances.beta?.goals[0]?.revision, 12);
    } finally { pending.resolve(); goals.close(); await peer.close(); await rm(directory, { recursive: true, force: true }); }
});
