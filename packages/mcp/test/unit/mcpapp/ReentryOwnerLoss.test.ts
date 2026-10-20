import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { asInstanceName, createToolCallRuntime, type JsonValue } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { createAuditRuntime } from "../../../../core/src/audit/index.ts";
import { createToolCallExecutionRuntime } from "../../../../core/src/toolcall/index.ts";
import { GoalService } from "../../../../core/src/task/goal/index.ts";
import { GoalState } from "../../../../core/src/task/goal/storage/State.ts";
import { TodoService } from "../../../../core/src/task/todo/index.ts";
import { installMcpAppReentry } from "../../../../core/src/instance/mcpapp/Reentry.ts";
import { McpAppActionStore } from "../../../src/mcpapp/ActionStore.ts";
import { deliverMcpAppReentry } from "../../../src/mcpapp/Reentry.ts";
import { createTestContextRuntime } from "../../ContextRuntime.ts";

async function durableReentry(intent: "goal-resume" | "task-resume" = "goal-resume") {
    const directory = await createTestTempDirectory("reentry-owner-loss-sqlite");
    const instance = asInstanceName("local");
    let clock = Date.parse("2026-10-20T00:00:00.000Z");
    const now = () => clock;
    const contexts = createTestContextRuntime({ contextFile: join(directory, "contexts.json") });
    await contexts.initialize();
    const context = await contexts.registry.create({ principal: "owner", environments: [{ instance, workspace: directory }] });
    const actionPath = join(directory, "actions.json");
    const createServices = async () => {
        const goal = new GoalService({ appendEvent: async () => undefined, filePath: join(directory, "goals.json"),
            instanceName: instance, state: new GoalState({ now: () => new Date(clock).toISOString() }) });
        const todo = new TodoService({ appendEvent: async () => undefined, filePath: join(directory, "todo.json"), instanceName: instance });
        const actions = new McpAppActionStore({ filePath: actionPath, now });
        await actions.initialize();
        const audit = createAuditRuntime({ filePath: join(directory, "audit.sqlite"), instanceName: instance, eventBufferSize: 32 });
        const execution = createToolCallExecutionRuntime({ audit: audit.api, instanceName: instance,
            appendEvent: async () => undefined, assertReady() {}, endpoint: {} as never,
            readTools: async () => [], releaseWorkspace: async () => undefined,
            prepareWorkspace: async () => { throw new Error("Reentry must use the registered Instance executor"); },
        });
        const native = createToolCallRuntime({ resolveTarget: () => execution.target() });
        const stop = installMcpAppReentry(native.hooks, { goal, todo } as never);
        return { goal, todo, actions, audit, execution, native,
            async close() { stop(); native.close(); await execution.close(); await audit.close(); } };
    };
    let services = await createServices();
    const goal = await services.goal.manage(context.ctxId, { action: "start", workspace: directory,
        objective: "Recover after owner loss", steps: [{ id: "work", text: "Continue work" }] });
    assert.ok(goal);
    const task = await services.todo.write({ revision: 0, title: "Resumed Task", todos: [
        { id: "work", content: "Continue task", status: "in_progress" },
    ] }, context.ctxId);
    assert.ok(task.taskId);
    const sourceId = intent === "task-resume" ? task.taskId : goal.goalId;
    const directiveId = "owner-loss-directive";
    await services.actions.prepare(context.ctxId, instance, { actionId: directiveId, itemId: sourceId,
        instance, operation: intent, targetId: sourceId });
    const effect = { kind: "reentry" as const, id: directiveId, intent, sourceId };
    await services.actions.apply(directiveId, effect);
    const base = { ctxId: context.ctxId, directiveId, sourceId, intent, claimId: "owner-a" };
    const raw = (input: Record<string, JsonValue>) => services.native.api.call(instance, "mcpapp_reentry", { ...base, ...input },
        { source: "mcp", ctxId: context.ctxId, workspace: directory });
    const call = (input: Record<string, JsonValue>) => deliverMcpAppReentry({ actions: services.actions,
        context: { resolve: contexts.resolve }, instance,
        dispatch: { callTool: async (_name, payload) => raw(payload as Record<string, JsonValue>) },
        view: { snapshot: async () => ({ presentation: { work: [] }, modelContext: { content: [] } }) } as never,
    }, { ...base, ...input }, { principal: "owner" });
    return { call, raw, base, effect, directiveId, context,
        get actions() { return services.actions; },
        readGoal: () => services.goal.read(context.ctxId),
        records: () => services.execution.readToolCalls(),
        advance(ms: number) { clock += ms; },
        async restart() { await services.close(); services = await createServices(); },
        async close() { await services.close(); await contexts.close(); },
    };
}

type Fixture = Awaited<ReturnType<typeof durableReentry>>;
const reserve = async (f: Fixture) => { assert.ok(await f.actions.beginDelivery(f.directiveId, f.base.claimId)); };
const claim = async (f: Fixture) => { assert.equal((await f.call({ action: "claim" }) as { claimed: boolean }).claimed, true); };
const beginAttempt = async (f: Fixture) => { assert.ok(await f.actions.beginAttempt(f.directiveId, f.base.claimId)); };
const attempt = async (f: Fixture) => { assert.equal((await f.call({ action: "attempt" }) as { attempted: boolean }).attempted, true); };
const beginReport = async (f: Fixture) => { assert.ok(await f.actions.beginReport(f.directiveId, f.base.claimId, "accepted")); };

for (const intent of ["goal-resume", "task-resume"] as const) {
    for (const state of [
        { name: "applied", steps: [] },
        { name: "reserved before Instance claim", steps: [reserve] },
        { name: "Instance claim committed before receipt acknowledgement", steps: [reserve, async (f: Fixture) => {
            assert.equal((await f.raw({ action: "claim" }) as { claimed: boolean }).claimed, true);
        }] },
        { name: "claimed before attempt", steps: [claim] },
    ]) {
        test(`SQLite ${intent}: crash at ${state.name} exposes an unattempted directive and replacement owner recovers`, async (t) => {
            const f = await durableReentry(intent); t.after(() => f.close());
            for (const step of state.steps) await step(f);
            f.advance(6 * 60_000);
            await f.restart();
            assert.deepEqual(await f.actions.pendingDirectives(f.context.ctxId, "local"), [f.effect]);
            assert.equal((await f.call({ action: "claim", claimId: "replacement-owner" }) as { claimed: boolean }).claimed, true);
            assert.deepEqual(await f.call({ action: "attempt" }), { attempted: false });
            assert.deepEqual(await f.call({ action: "release" }), { released: false });
            assert.deepEqual(await f.call({ action: "report", outcome: "accepted" }), { reported: false });
            assert.equal((await f.call({ action: "attempt", claimId: "replacement-owner" }) as { attempted: boolean }).attempted, true);
            assert.deepEqual(await f.call({ action: "attempt", claimId: "replacement-owner" }), { attempted: false, duplicate: true });
            await f.call({ action: "report", claimId: "replacement-owner", outcome: "accepted" });
            assert.equal((await f.actions.get(f.directiveId))?.status, "settled");
            const attempts = (await f.records()).filter((row) => (row.input as { action?: string }).action === "attempt");
            assert.equal(attempts.length, 1);
        });
    }

    for (const state of [
        { name: "attempt intent persisted before dispatch", steps: [claim, beginAttempt] },
        { name: "Instance attempt committed before receipt acknowledgement", steps: [claim, beginAttempt, async (f: Fixture) => {
            assert.equal((await f.raw({ action: "attempt" }) as { attempted: boolean }).attempted, true);
        }] },
        { name: "attempted", steps: [claim, attempt] },
        { name: "reporting", steps: [claim, attempt, beginReport] },
        { name: "Instance report committed", steps: [claim, attempt, beginReport, async (f: Fixture) => {
            await f.raw({ action: "report", outcome: "accepted" });
        }] },
        { name: "settled", steps: [claim, attempt, async (f: Fixture) => { await f.call({ action: "report", outcome: "accepted" }); }] },
    ]) {
        test(`SQLite ${intent}: crash at ${state.name} never reoffers or dispatches for a replacement owner`, async (t) => {
            const f = await durableReentry(intent); t.after(() => f.close());
            for (const step of state.steps) await step(f);
            f.advance(6 * 60_000);
            await f.restart();
            const before = await f.records();
            const receipt = await f.actions.get(f.directiveId);
            assert.deepEqual(await f.actions.pendingDirectives(f.context.ctxId, "local"), []);
            assert.deepEqual(await f.call({ action: "claim", claimId: "replacement-owner" }), { claimed: false });
            assert.deepEqual(await f.call({ action: "attempt", claimId: "replacement-owner" }), { attempted: false });
            assert.deepEqual(await f.call({ action: "release", claimId: "replacement-owner" }), { released: false });
            assert.deepEqual(await f.call({ action: "report", claimId: "replacement-owner", outcome: "accepted" }), { reported: false });
            assert.deepEqual(await f.records(), before);
            assert.deepEqual(await f.actions.get(f.directiveId), receipt);
        });
    }
}

test("SQLite Reentry reservation cannot attempt or validate before Instance claim confirmation", async (t) => {
    const f = await durableReentry("task-resume"); t.after(() => f.close());
    await reserve(f);
    assert.deepEqual(await f.call({ action: "validate" }), { valid: false });
    assert.deepEqual(await f.call({ action: "attempt" }), { attempted: false });
    assert.deepEqual(await f.records(), []);
});

test("SQLite Reentry owner loss before Instance claim recovers immediately without a retry delay", async (t) => {
    const f = await durableReentry(); t.after(() => f.close());
    await reserve(f);
    await f.restart();
    assert.equal((await f.readGoal())?.continuationPending, false);
    assert.deepEqual(await f.actions.pendingDirectives(f.context.ctxId, "local"), [f.effect]);
    assert.equal((await f.call({ action: "claim", claimId: "replacement-owner" }) as { claimed: boolean }).claimed, true);
    assert.deepEqual(await f.call({ action: "attempt" }), { attempted: false });
    assert.equal((await f.call({ action: "attempt", claimId: "replacement-owner" }) as { attempted: boolean }).attempted, true);
});

test("SQLite Reentry preserves the Instance claim through the 180s Wait and recovers only after authoritative expiry", async (t) => {
    const f = await durableReentry(); t.after(() => f.close());
    await claim(f);
    await f.restart();
    f.advance(180_000);
    const receipt = await f.actions.get(f.directiveId);
    assert.deepEqual(await f.call({ action: "claim", claimId: "replacement-owner" }), { claimed: false });
    assert.deepEqual(await f.actions.get(f.directiveId), receipt);
    assert.equal((await f.call({ action: "validate" }) as { valid: boolean }).valid, true);
    f.advance(120_001);
    assert.equal((await f.call({ action: "claim", claimId: "replacement-owner" }) as { claimed: boolean }).claimed, true);
    assert.deepEqual(await f.call({ action: "attempt" }), { attempted: false });
    assert.equal((await f.call({ action: "attempt", claimId: "replacement-owner" }) as { attempted: boolean }).attempted, true);
    await f.call({ action: "report", claimId: "replacement-owner", outcome: "accepted" });
    assert.equal((await f.readGoal())?.continuationCount, 1);
});

test("SQLite Reentry explicitly refused attempt remains releasable and usable after claim expiry", async (t) => {
    const f = await durableReentry(); t.after(() => f.close());
    await claim(f);
    f.advance(6 * 60_000);
    assert.deepEqual(await f.call({ action: "attempt" }), { attempted: false });
    assert.deepEqual(await f.call({ action: "release" }), { released: true });
    assert.equal((await f.actions.get(f.directiveId))?.status, "applied");
    assert.deepEqual(await f.actions.pendingDirectives(f.context.ctxId, "local"), [f.effect]);
    assert.equal((await f.call({ action: "claim", claimId: "replacement-owner" }) as { claimed: boolean }).claimed, true);
    assert.equal((await f.call({ action: "attempt", claimId: "replacement-owner" }) as { attempted: boolean }).attempted, true);
});
