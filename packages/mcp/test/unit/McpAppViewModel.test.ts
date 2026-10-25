import assert from "node:assert/strict";
import test from "node:test";
import { asInstanceName, Endpoint, Rpc, Stream, type ApprovalRequest, type GoalSnapshot, type ToolCallRecord, type WaitRecord } from "@portable-devshell/shared";
import { createMcpAppViewModel, mcpAppEventAffectsContext, projectMcpAppSnapshot } from "../../src/mcpapp/ViewModel.ts";

test("MCP App ViewModel ignores unrelated Context events but observes global and unknown events", () => {
    const event = (type: string, data?: Record<string, string>) => ({
        at: "", instanceName: asInstanceName("demo"), seq: 17, type,
        ...(data === undefined ? {} : { data }),
    });
    for (const type of ["goal.updated", "wait.resolved", "toolCall.completed"]) {
        assert.equal(mcpAppEventAffectsContext(event(type, { ctxId: "other" }), "ctx-a"), false);
        assert.equal(mcpAppEventAffectsContext(event(type, { ctxId: "ctx-a" }), "ctx-a"), true);
        assert.equal(mcpAppEventAffectsContext(event(type), "ctx-a"), true);
    }
    assert.equal(mcpAppEventAffectsContext(event("other.changed", { ctxId: "other" }), "ctx-a"), true);
    assert.equal(mcpAppEventAffectsContext(event("instance.started"), "ctx-a"), true);
});

test("MCP App watch recovers a resolved Wait with no delivered Audit event", async (t) => {
    const endpoint = new Endpoint({ host: "mcpapp-test" });
    endpoint.connect = async (host, port) => endpoint.bind(`client-${port}`).connect(host, port);
    let status: WaitRecord["status"] = "detached";
    let reads = 0;
    const task = new Rpc(endpoint.bind("task", "test"), {
        getGoal: () => ({ goal: null, lastSeq: 10 }),
        getWaits: () => {
            reads++;
            return { lastSeq: 10, waits: [{
                waitId: "wait-a", ctxId: "ctx-a", callId: "call-a",
                instance: "test", source: "mcp", targetId: "task-a",
                toolName: "tmux_run", createdAt: "", updatedAt: "", status,
            }] };
        },
    });
    const approval = new Rpc(endpoint.bind("approval", "test"), {
        snapshot: () => ({ approvals: [], lastSeq: 10 }),
    });
    const tool = new Rpc(endpoint.bind("tool", "test"), { listCalls: () => [] });
    const events = new Stream(endpoint.bind("instance", "test"));
    events.onOpen((_stream, name) => { assert.equal(name, "subscribeEvents"); });
    const timeout = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (
        callback: Parameters<typeof setTimeout>[0], ms?: number, ...args: unknown[]
    ) => timeout(callback, ms === 20_000 ? 5 : ms, ...args));
    t.after(() => {
        t.mock.restoreAll();
        events.close(); tool.close(); approval.close(); task.close(); endpoint.close();
    });
    const view = createMcpAppViewModel(endpoint);
    const initial = await view.snapshot("test", "ctx-a");
    assert.equal(initial.presentation.background[0]?.badge, "Wait · detached");
    status = "resolved";
    const refreshed = await view.watch("test", "ctx-a", undefined, initial.cursor);
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.snapshot?.presentation.background[0]?.badge, "Wait · resolved");
    assert.ok(reads >= 2, "polling must read the authoritative Wait state without a new event");
});

test("MCP App ViewModel isolates Context approvals, waits, and Context-owned goal", () => {
    const goal = (goalId: string, workspace: string): GoalSnapshot => ({
        goalId, workspace, objective: goalId, status: "active",
        continuationDue: false, continuationDueAt: "", continuationPending: false,
        continuationUncertain: false, continuationCount: 0, autoContinueExhausted: false,
        createdAt: "", updatedAt: "", lastAgentActivityAt: "", lastProgressAt: "",
        revision: 1,
    });
    const approval = (approvalId: string, ctxId: string): ApprovalRequest => ({
        approvalId, ctxId, callId: approvalId, createdAt: "", expiresAt: "",
        inputSummary: approvalId, instance: "test" as ApprovalRequest["instance"],
        reason: "", riskLevel: "low", source: "mcp", status: "pending", toolName: "bash_run",
    });
    const wait = (waitId: string, ctxId: string): WaitRecord => ({
        waitId, ctxId, callId: waitId, instance: "test" as WaitRecord["instance"],
        createdAt: "", updatedAt: "", status: "detached", source: "mcp",
        targetId: waitId, toolName: "tmux_read", result: { stdout: "private-worker-output" },
    });
    const snapshot = projectMcpAppSnapshot({
        ctxId: "ctx-a",
        instance: "test",
        workspace: "/allowed",
        approvals: { approvals: [approval("allowed", "ctx-a"), approval("allowed-2", "ctx-a"), approval("secret", "ctx-b")], lastSeq: 15 },
        goal: { goal: goal("allowed-goal", "/allowed"), lastSeq: 12 },
        waits: { waits: [wait("allowed-wait", "ctx-a"), wait("secret-wait", "ctx-b")], lastSeq: 14 },
    });
    assert.equal(snapshot.cursor, 12);
    assert.equal(snapshot.agentBusy, false);
    assert.equal(snapshot.presentation.work[0]?.state, "running");
    assert.equal(snapshot.presentation.primary?.id, "allowed");
    assert.equal(snapshot.presentation.pendingApprovals, 2);
    assert.deepEqual(snapshot.presentation.work.map((entry) => entry.id), ["allowed-goal"]);
    assert.deepEqual(snapshot.presentation.background.map((entry) => entry.id), ["allowed-wait"]);
    assert.deepEqual(snapshot.presentation.primary?.actions.map((action) => action.id), ["approve", "deny"]);
    assert.deepEqual(snapshot.presentation.work[0]?.actions.map((action) => action.id), ["goal-pause", "goal-stop"]);
    assert.equal(snapshot.presentation.work[0]?.actions[0]?.expectedRevision, 1);
    assert.equal(snapshot.presentation.background.every((entry) => entry.actions.length === 0), true);
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
    assert.equal(JSON.stringify(snapshot).includes("private-worker-output"), false);
    assert.equal(snapshot.reentry.pending, false);
});

test("MCP App busy state follows live Context ToolCalls independently of Goals, history, and reentry", async (t) => {
    const endpoint = new Endpoint({ host: "mcpapp-test" });
    endpoint.connect = async (host, port) => endpoint.bind(`client-${port}`).connect(host, port);
    const goal: GoalSnapshot = {
        goalId: "active-goal", objective: "Finish the work", status: "active",
        continuationDue: true, continuationDueAt: "2026-01-01T00:00:00Z", continuationPending: false,
        continuationUncertain: false, continuationCount: 0, autoContinueExhausted: false,
        createdAt: "", updatedAt: "", lastAgentActivityAt: "", lastProgressAt: "", revision: 1,
    };
    let calls: ToolCallRecord[] = [];
    let activityReads = 0;
    let executionUnavailable = false;
    const task = new Rpc(endpoint.bind("task", "test"), {
        getGoal: () => ({ goal, lastSeq: 12 }),
        getWaits: () => ({ waits: [], lastSeq: 12 }),
    });
    const approval = new Rpc(endpoint.bind("approval", "test"), {
        snapshot: () => ({ approvals: [], lastSeq: 12 }),
    });
    const tool = new Rpc(endpoint.bind("tool", "test"), {
        listCalls: (request) => {
            const query = request as { ctxId: string; status?: string; limit: number };
            assert.equal(query.ctxId, "ctx-a");
            if (query.status === undefined) {
                activityReads++;
                return [];
            }
            assert.deepEqual(request, {
                ctxId: "ctx-a", status: "running", limit: 64, includeInput: false, includeOutput: false,
            });
            if (executionUnavailable) throw new Error("Execution authority unavailable");
            return calls.filter((call) => call.ctxId === query.ctxId && call.status === query.status)
                .slice(0, query.limit);
        },
    });
    t.after(() => {
        tool.close(); approval.close(); task.close(); endpoint.close();
    });
    const view = createMcpAppViewModel(endpoint);
    const idle = await view.snapshot("test", "ctx-a");
    assert.equal(idle.agentBusy, false);
    assert.equal(idle.presentation.work[0]?.id, goal.goalId);
    assert.equal(idle.presentation.work[0]?.state, "running");
    assert.equal(idle.reentry.schedule?.sourceId, goal.goalId);
    const call = (ctxId: string, status: ToolCallRecord["status"]): ToolCallRecord => ({
        callId: ctxId, ctxId, status, instance: asInstanceName("test"), source: "mcp",
        startedAt: "2025-01-01T00:00:00Z", inputSummary: "", toolName: "bash_run",
    });
    calls = [call("ctx-other", "running"), call("ctx-a", "queued")];
    assert.equal((await view.snapshot("test", "ctx-a")).agentBusy, false);
    calls = [call("ctx-a", "running")];
    const busy = await view.snapshot("test", "ctx-a");
    assert.equal(busy.agentBusy, true);
    assert.equal(busy.activity, undefined);
    assert.equal(activityReads, 0, "Live snapshots must not query historical ToolCalls");
    assert.deepEqual(await view.activity("test", "ctx-a"), []);
    assert.equal(activityReads, 1, "Activity history is requested separately");
    assert.deepEqual(busy.presentation.work, idle.presentation.work);
    assert.equal(busy.reentry.schedule, undefined, "An active ToolCall prevents duplicate Goal recovery");
    calls = [{ ...call("ctx-a", "running"), toolName: "mcpapp_open" }];
    const uiOnly = await view.snapshot("test", "ctx-a");
    assert.equal(uiOnly.agentBusy, false);
    assert.equal(uiOnly.reentry.schedule?.sourceId, goal.goalId);
    calls = [call("ctx-a", "completed")];
    assert.equal((await view.snapshot("test", "ctx-a")).agentBusy, false);
    executionUnavailable = true;
    assert.equal((await view.snapshot("test", "ctx-a")).agentBusy, false);
});

test("MCP App ViewModel rejects a goal with a different Context workspace", () => {
    const snapshot = projectMcpAppSnapshot({
        ctxId: "ctx-a", instance: "test", approvals: { approvals: [], lastSeq: 0 },
        workspace: "/allowed",
        goal: { goal: { goalId: "secret", workspace: "/other" } as GoalSnapshot, lastSeq: 0 },
    });
    assert.deepEqual(snapshot.presentation.work, []);
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});
