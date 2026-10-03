import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue, ToolCallContext, WaitRecord } from "@portable-devshell/shared";
import { attemptWorkspaceDelivery, executeWorkspaceAction, readWorkspaceDeliveryOutcome, reportWorkspaceDelivery, validateWorkspaceDirectiveClaim, validateWorkspaceQuestionAnswer, WorkspaceActionStaleError, workspaceWaitReentryEffect } from "../../src/workspace/Action.ts";
import { WorkspaceActionStore } from "../../src/workspace/ActionStore.ts";
import { workspaceIdentity } from "../../src/workspace/model/Identity.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("Workspace action receipt persists effect before delivery and fails closed after an uncertain attempt", async () => {
    const root = await createTestTempDirectory("workspace-action-outbox");
    const filePath = join(root, "workspace-actions.json");
    try {
        const actionId = "deterministic-action";
        const effect = { kind: "reentry" as const, id: actionId, intent: "goal-retry" as const, sourceId: "goal-1" };
        const first = new WorkspaceActionStore({ filePath });
        await first.initialize();
        await first.prepare("ctx-a", "alpha", {
            actionId, itemId: "goal-1", instance: "alpha", operation: "goal-retry", targetId: "goal-1", revision: 4,
        });
        await first.apply(actionId, effect);
        assert.deepEqual(await first.pendingDirectives("ctx-a", "alpha"), [effect]);
        assert.deepEqual(await first.pendingDirectives("ctx-b", "alpha"), []);
        assert.deepEqual(await first.pendingDirectives("ctx-a", "beta"), []);

        const restarted = new WorkspaceActionStore({ filePath });
        await restarted.initialize();
        assert.equal((await restarted.beginDelivery(actionId))?.status, "attempting");
        assert.equal(await restarted.beginDelivery(actionId), undefined);
        assert.deepEqual(await restarted.pendingDirectives("ctx-a", "alpha"), []);
        assert.equal((await restarted.get(actionId))?.status, "attempting");
        assert.match(await readFile(filePath, "utf8"), /"status": "attempting"/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("invalid question input does not prepare a receipt and corrected input applies the same action", async () => {
    const ctxId = "ctx-question";
    const instance = "alpha";
    const wait = {
        waitId: "wait-question",
        kind: "question",
        createdByCtxId: ctxId,
        targetId: "question-1",
        status: "waiting",
        payload: { allowText: false, choices: ["yes", "no"] },
        createdAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T00:00:00.000Z",
    } as unknown as WaitRecord;
    let currentWait = wait;
    const gateway = {
        createWait: async () => wait,
        detachWait: async () => currentWait,
        consumeWait: async () => currentWait,
        resolveWait: async (_instance: string, _waitId: string, result?: JsonValue) => {
            currentWait = { ...currentWait, status: "resolved", result } as WaitRecord;
            return currentWait;
        },
        waitForWait: async () => currentWait,
        listWaits: async () => [currentWait],
        readTodo: async () => ({ tasks: [] }),
        readWorkspaceEvents: async () => ({ events: [], gap: false, lastSeq: 1 }),
        readToolCalls: async () => [],
        hasActiveToolCalls: async () => false,
        approval: {
            listPendingApprovals: async () => [],
            listApprovals: async () => [],
            decideApproval: async () => ({}),
        },
    };
    const store = new WorkspaceActionStore();
    const actionId = workspaceIdentity(ctxId, instance, wait.waitId, "question-answer");
    const context = { ctxId } as ToolCallContext;
    let mutations = 0;
    let questionDisappearsAfterProjection = false;
    const invoke = (answer: string) => executeWorkspaceAction({
        store,
        instance,
        contextInstances: async () => [instance],
        reentry: async () => undefined,
        snapshot: async () => ({
            ctxId, instance, cursor: 1, agentBusy: false,
            presentation: { work: [], background: [] },
            modelContext: { content: [], structuredContent: { portableDevshellWorkspace: {} } },
            reentry: { pending: false },
        }),
        preflight: async (action, request) => {
            if (action.operation !== "question-answer") return;
            if (questionDisappearsAfterProjection) throw new WorkspaceActionStaleError();
            if (typeof request.input !== "string" || request.input.trim().length === 0) throw new Error("answer must be non-empty");
            validateWorkspaceQuestionAnswer(currentWait, request.input.trim());
        },
        mutate: async (_action, request) => {
            mutations += 1;
            currentWait = { ...currentWait, status: "resolved", result: { answer: request.input ?? "" } } as WaitRecord;
            return undefined;
        },
    }, gateway as never, { actionId, itemId: wait.waitId, input: answer }, context);

    await assert.rejects(invoke("not offered"), /offered choices/u);
    assert.equal(await store.get(actionId), undefined);
    await assert.rejects(invoke("x".repeat(20_001)), /at most 20000/u);
    assert.equal(await store.get(actionId), undefined);

    questionDisappearsAfterProjection = true;
    assert.equal((await invoke("yes") as { status?: string }).status, "stale");
    assert.equal(await store.get(actionId), undefined);
    questionDisappearsAfterProjection = false;

    const result = await invoke("yes");
    assert.equal((result as { status?: string }).status, "applied");
    assert.equal((await store.get(actionId))?.status, "applied");
    assert.deepEqual(currentWait.result, { answer: "yes" });
    assert.equal(mutations, 1);
});

test("concurrent Apps with the same stable claim only own one delayed directive attempt", async () => {
    const store = new WorkspaceActionStore();
    const directiveId = "shared-action";
    await store.prepare("ctx-shared", "alpha", {
        actionId: directiveId, itemId: "wait-1", instance: "alpha", operation: "wait-interrupt", targetId: "wait-1",
    });
    await store.apply(directiveId, { kind: "reentry", intent: "automatic", sourceId: "wait-1", id: directiveId });
    const claimId = `workspace-action-${directiveId}`;
    validateWorkspaceDirectiveClaim(directiveId, claimId);
    let finish!: (value: JsonValue) => void;
    let attemptCalls = 0;
    const delayed = new Promise<JsonValue>((resolve) => { finish = resolve; });
    const attempt = () => {
        attemptCalls += 1;
        return delayed;
    };
    const first = attemptWorkspaceDelivery(store, directiveId, attempt);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await attemptWorkspaceDelivery(store, directiveId, attempt);
    assert.deepEqual(second, { attempted: false, duplicate: true });
    assert.equal(attemptCalls, 1);
    finish({ attempted: true, claimed: true });
    assert.deepEqual(await first, { attempted: true, claimed: true });
    assert.equal((await store.get(directiveId))?.status, "attempted");
});

test("a lost action snapshot preserves its directive across restart without repeating the mutation", async () => {
    const root = await createTestTempDirectory("workspace-action-lost-response");
    const filePath = join(root, "actions.json");
    const ctxId = "ctx-lost";
    const instance = "alpha";
    const waitId = "wait-lost";
    const actionId = workspaceIdentity(ctxId, instance, waitId, "question-answer");
    let mutations = 0;
    const gateway = {
        readTodo: async () => ({ tasks: [] }),
        listWaits: async () => [{ waitId, createdByCtxId: ctxId, kind: "question", status: "detached", payload: { question: "Continue?" }, updatedAt: "2026-10-02T00:00:00.000Z" }],
        resolveWait: async () => ({}),
        approval: { listPendingApprovals: async () => [] },
    };
    const effect = { kind: "reentry" as const, intent: "automatic" as const, sourceId: waitId, id: actionId };
    try {
        const first = new WorkspaceActionStore({ filePath });
        await first.initialize();
        await assert.rejects(executeWorkspaceAction({
            store: first, instance, contextInstances: async () => [instance], reentry: async () => undefined,
            mutate: async () => { mutations += 1; return effect; },
            snapshot: async () => { throw new Error("snapshot transport lost"); },
        }, gateway as never, { itemId: waitId, actionId, input: "yes" }, { ctxId } as ToolCallContext), /snapshot transport lost/u);
        assert.equal(mutations, 1);
        assert.equal((await first.get(actionId))?.status, "applied");
        const restarted = new WorkspaceActionStore({ filePath });
        await restarted.initialize();
        const result = await executeWorkspaceAction({
            store: restarted, instance, contextInstances: async () => [instance], reentry: async () => undefined,
            mutate: async () => { mutations += 1; return effect; },
            snapshot: async (_gateway, id, directives) => ({
                ctxId: id, instance, cursor: 1, agentBusy: false, presentation: { work: [], background: [] },
                modelContext: { content: [], structuredContent: { portableDevshellWorkspace: {} } },
                reentry: { pending: false, directives },
            }),
        }, gateway as never, { itemId: waitId, actionId, input: "yes" }, { ctxId } as ToolCallContext);
        assert.equal((result as { status?: string }).status, "stale");
        assert.deepEqual((result as unknown as { snapshot: { reentry: { directives: unknown[] } } }).snapshot.reentry.directives, [effect]);
        assert.equal(mutations, 1);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("delivery validation precedes receipt gates and mutation result controls raced wait effects", async () => {
    const store = new WorkspaceActionStore();
    const directiveId = "validated-action";
    await store.prepare("ctx-valid", "alpha", {
        actionId: directiveId, itemId: "wait-1", instance: "alpha", operation: "wait-interrupt", targetId: "wait-1",
    });
    await store.apply(directiveId, { kind: "reentry", intent: "automatic", sourceId: "wait-1", id: directiveId });
    await store.beginDelivery(directiveId);
    await store.markAttempted(directiveId);
    assert.throws(() => validateWorkspaceDirectiveClaim(directiveId, "another-claim"), /does not match/u);
    assert.throws(() => readWorkspaceDeliveryOutcome("maybe"), /outcome is invalid/u);
    assert.equal((await store.get(directiveId))?.status, "attempted");
    assert.deepEqual(workspaceWaitReentryEffect({ detached: true }, "wait-raced"), {
        kind: "reentry", intent: "automatic", sourceId: "wait-raced",
    });
    assert.equal(workspaceWaitReentryEffect({ detached: false }, "wait-raced"), undefined);
});

test("duplicate settled delivery reports are idempotent and never rerun arbitration", async () => {
    const store = new WorkspaceActionStore();
    const directiveId = "report-action";
    await store.prepare("ctx-report", "alpha", {
        actionId: directiveId, itemId: "wait-1", instance: "alpha", operation: "wait-interrupt", targetId: "wait-1",
    });
    await store.apply(directiveId, { kind: "reentry", intent: "automatic", sourceId: "wait-1", id: directiveId });
    await store.beginDelivery(directiveId);
    await store.markAttempted(directiveId);
    let reportCalls = 0;
    const report = async () => {
        reportCalls += 1;
        return { reported: true };
    };
    assert.deepEqual(await reportWorkspaceDelivery(store, directiveId, "accepted", report), { reported: true });
    assert.deepEqual(await reportWorkspaceDelivery(store, directiveId, "accepted", report), {
        reported: true, duplicate: true, outcome: "accepted",
    });
    assert.equal(reportCalls, 1);
    assert.equal((await store.get(directiveId))?.status, "settled");
});
