import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { TodoService } from "../../../src/task/todo/index.ts";
import { TodoCommitError, TodoState, TodoStore } from "../../../src/task/todo/Store.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

const eio = () => Object.assign(new Error("injected EIO"), { code: "EIO" });
const plan = {
    revision: 0,
    title: "Commit boundary",
    todos: [{ id: "one", content: "A", status: "pending" as const }],
};

async function fixture(t: TestContext) {
    const root = await createTestTempDirectory("todo-commit");
    const filePath = join(root, "todo.json");
    const events: Array<{ type: string; data: unknown }> = [];
    const options = {
        filePath,
        instanceName: "alpha",
        async appendEvent(type: string, data: unknown) {
            events.push({ type, data });
        },
    };
    const service = new TodoService(options);
    const created = await service.write(plan, "ctx-a");
    const update = { ...plan, taskId: created.taskId!, revision: 1 };
    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    return {
        root, filePath, service, update, events,
        fresh: () => new TodoService(options),
        changed: { ...update, todos: [{ ...plan.todos[0]!, content: "B" }] },
    };
}

function failDirectorySync(t: TestContext, directory: string) {
    const realOpen = promises.open;
    let failures = 0;
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
        const handle = await realOpen(...args);
        if (args[0] === directory && args[1] === "r") {
            t.mock.method(handle, "sync", async () => {
                failures++;
                throw eio();
            });
        }
        return handle;
    });
    syncBuiltinESMExports();
    return () => failures;
}

test("TodoService reconciles a visible rename after directory fsync EIO before noop and CAS", {
    skip: process.platform === "win32",
}, async (t) => {
    const f = await fixture(t);
    const failures = failDirectorySync(t, f.root);
    let failure: unknown;
    await assert.rejects(f.service.write(f.changed, "ctx-b"), (error: unknown) => {
        failure = error;
        return error instanceof Error;
    });
    assert.equal(failures(), 1);
    t.mock.restoreAll();
    syncBuiltinESMExports();

    const visible = await f.fresh().read({ taskId: f.update.taskId });
    assert.equal(visible.revision, 2);
    assert.equal(visible.items[0]?.content, "B");
    assert.deepEqual(await f.service.read({ taskId: f.update.taskId }), visible);
    assert.equal(f.service.summaries()[0]?.revision, 2);
    await assert.rejects(f.service.write(f.update, "ctx-a"), {
        code: "todo.revisionConflict",
    });
    await assert.rejects(f.service.write({
        ...f.changed, todos: [{ ...plan.todos[0]!, content: "C" }],
    }, "ctx-c"), { code: "todo.revisionConflict" });
    assert.deepEqual(await f.fresh().read({ taskId: f.update.taskId }), visible);
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created", "todo.updated"]);
    assert.equal((f.events[1]?.data as { revision: number }).revision, 2);

    const inode = (await promises.stat(f.filePath)).ino;
    assert.deepEqual(await f.service.write({ ...f.changed, revision: 2 }, "ctx-b"), visible);
    assert.equal((await promises.stat(f.filePath)).ino, inode);
    assert.equal(f.events.length, 2);
    const handoff = await f.service.write({ ...f.changed, revision: 2 }, "ctx-c");
    assert.equal(handoff.revision, 3);
    assert.equal((await f.service.read()).tasks?.[0]?.ctxId, "ctx-c");
    assert.ok(failure instanceof TodoCommitError);
    assert.equal(failure.code, "todo.commitDurabilityUnconfirmed");
    assert.equal(failure.retryable, false);
    assert.deepEqual(failure.details, {
        committed: true, filePath: f.filePath, phase: "directory-sync",
    });
    assert.equal(failure.causeBody?.code, "EIO");
});

test("TodoService classifies rename EIO after its filesystem effect and emits the committed event", async (t) => {
    const f = await fixture(t);
    const realRename = promises.rename;
    t.mock.method(promises, "rename", async (...args: Parameters<typeof promises.rename>) => {
        await realRename(...args);
        throw eio();
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.write(f.changed, "ctx-b"), {
        code: "todo.commitDurabilityUnconfirmed",
        retryable: false,
        details: { committed: true, filePath: f.filePath, phase: "rename" },
        causeBody: { code: "EIO", message: "injected EIO", retryable: false },
    });
    assert.equal((await f.service.read({ taskId: f.update.taskId })).revision, 2);
    assert.deepEqual(await f.service.read({ taskId: f.update.taskId }),
        await f.fresh().read({ taskId: f.update.taskId }));
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created", "todo.updated"]);
    await assert.rejects(f.service.write(f.update, "ctx-a"), { code: "todo.revisionConflict" });
    assert.deepEqual((await promises.readdir(f.root)).sort(), ["todo.json"]);
});

test("TodoService retains the previous revision and emits no event when rename has no effect", async (t) => {
    const f = await fixture(t);
    const before = await promises.readFile(f.filePath, "utf8");
    t.mock.method(promises, "rename", async () => { throw eio(); });
    syncBuiltinESMExports();
    await assert.rejects(f.service.write(f.changed, "ctx-b"), { code: "EIO" });
    assert.equal((await f.service.read({ taskId: f.update.taskId })).revision, 1);
    assert.equal(await promises.readFile(f.filePath, "utf8"), before);
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created"]);
    assert.deepEqual((await promises.readdir(f.root)).sort(), ["todo.json"]);
});

test("TodoService reconciles an uncertain rename on recovery before allowing a stale write", async (t) => {
    const f = await fixture(t);
    const realRename = promises.rename;
    const realRead = fs.readFileSync;
    let renamed = false;
    t.mock.method(promises, "rename", async (...args: Parameters<typeof promises.rename>) => {
        await realRename(...args);
        renamed = true;
        throw eio();
    });
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (renamed && args[0] === f.filePath) {
            throw Object.assign(new Error("probe unavailable"), { code: "EACCES" });
        }
        return realRead(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.write(f.changed, "ctx-b"), {
        code: "todo.commitUncertain", retryable: false,
        details: { committed: "unknown", filePath: f.filePath, phase: "rename" },
    });
    await assert.rejects(f.service.write(f.update, "ctx-a"), { code: "todo.invalid" });
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created"]);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(f.service.summaries()[0]?.revision, 2);
    assert.equal((await f.service.read({ taskId: f.update.taskId })).revision, 2);
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created", "todo.updated"]);
    await assert.rejects(f.service.write(f.update, "ctx-a"), { code: "todo.revisionConflict" });
    await f.service.read();
    assert.equal(f.events.length, 2);
});

test("TodoService rejects an already queued stale writer after a visible commit reports EIO", {
    skip: process.platform === "win32",
}, async (t) => {
    const f = await fixture(t);
    failDirectorySync(t, f.root);
    const [first, second] = await Promise.allSettled([
        f.service.write(f.changed, "ctx-b"),
        f.service.write({
            ...f.update, todos: [{ ...plan.todos[0]!, content: "C" }],
        }, "ctx-c"),
    ]);
    assert.equal(first!.status, "rejected");
    assert.equal(second!.status, "rejected");
    assert.equal((first as PromiseRejectedResult).reason.code, "todo.commitDurabilityUnconfirmed");
    assert.equal((second as PromiseRejectedResult).reason.code, "todo.revisionConflict");
    const current = await f.service.read({ taskId: f.update.taskId });
    assert.equal(current.revision, 2);
    assert.equal(current.items[0]?.content, "B");
    assert.deepEqual(current, await f.fresh().read({ taskId: f.update.taskId }));
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created", "todo.updated"]);
});

test("TodoService discards pending events when an uncertain rename did not replace the file", async (t) => {
    const f = await fixture(t);
    const before = await promises.readFile(f.filePath, "utf8");
    const realRead = fs.readFileSync;
    let attempted = false;
    t.mock.method(promises, "rename", async () => {
        attempted = true;
        throw eio();
    });
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        if (attempted && args[0] === f.filePath) throw eio();
        return realRead(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.write(f.changed, "ctx-b"), {
        code: "todo.commitUncertain", retryable: false,
    });
    assert.equal(await promises.readFile(f.filePath, "utf8"), before);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal((await f.service.read({ taskId: f.update.taskId })).revision, 1);
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created"]);
    const retried = await f.service.write(f.changed, "ctx-b");
    assert.equal(retried.revision, 2);
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created", "todo.updated"]);
});

test("TodoService leaves state and events unchanged when the temporary file cannot be synced", async (t) => {
    const f = await fixture(t);
    const before = await promises.readFile(f.filePath, "utf8");
    const realOpen = promises.open;
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
        const handle = await realOpen(...args);
        if (args[1] === "wx") t.mock.method(handle, "sync", async () => { throw eio(); });
        return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(f.service.write(f.changed, "ctx-b"), { code: "EIO" });
    assert.equal(await promises.readFile(f.filePath, "utf8"), before);
    assert.equal((await f.service.read({ taskId: f.update.taskId })).revision, 1);
    assert.deepEqual(f.events.map((event) => event.type), ["todo.created"]);
    assert.deepEqual((await promises.readdir(f.root)).sort(), ["todo.json"]);
});

test("TodoService delivers both terminal events despite fsync and audit failures", {
    skip: process.platform === "win32",
}, async (t) => {
    const f = await fixture(t);
    const attempts: string[] = [];
    const service = new TodoService({
        filePath: f.filePath,
        instanceName: "alpha",
        async appendEvent(type) {
            attempts.push(type);
            throw new Error("audit unavailable");
        },
    });
    failDirectorySync(t, f.root);
    await assert.rejects(service.write({
        ...f.update, todos: [{ ...plan.todos[0]!, status: "completed" }],
    }, "ctx-finish"), {
        code: "todo.commitDurabilityUnconfirmed",
        causeBody: { code: "EIO", message: "injected EIO", retryable: false },
    });
    assert.deepEqual(attempts, ["todo.completed", "todo.archived"]);
    assert.deepEqual((await service.read()).tasks, []);
    assert.equal((await service.read({ taskId: f.update.taskId })).revision, 2);
    assert.deepEqual(await service.read({ taskId: f.update.taskId }),
        await f.fresh().read({ taskId: f.update.taskId }));
    await assert.rejects(service.write(f.update, "ctx-a"), { code: "todo.invalid" });
    assert.equal(attempts.length, 2);
});

test("TodoService pause, cancelAll and delete publish visible commits even when directory fsync fails", {
    skip: process.platform === "win32",
}, async (t) => {
    const f = await fixture(t);
    failDirectorySync(t, f.root);
    await assert.rejects(f.service.control(f.update.taskId, "pause", "ctx-pause", 1), {
        code: "todo.commitDurabilityUnconfirmed",
    });
    const paused = await f.service.read({ taskId: f.update.taskId });
    assert.equal(paused.revision, 2);
    assert.equal(typeof paused.pausedAt, "string");
    assert.deepEqual(paused, await f.fresh().read({ taskId: f.update.taskId }));
    await assert.rejects(f.service.control(f.update.taskId, "resume", "ctx-resume", 1), {
        code: "todo.invalid", message: /changed from revision 1 to 2/u,
    });
    assert.equal(f.events.length, 2);
    await assert.rejects(f.service.cancelAll(), { code: "todo.commitDurabilityUnconfirmed" });
    assert.deepEqual(f.service.summaries(), []);
    const cancelled = await f.service.read({ taskId: f.update.taskId });
    assert.equal(cancelled.revision, 3);
    assert.equal(typeof cancelled.cancelledAt, "string");
    assert.deepEqual(cancelled, await f.fresh().read({ taskId: f.update.taskId }));
    await f.service.cancelAll();
    assert.deepEqual(f.events.map((event) => event.type), [
        "todo.created", "todo.updated", "todo.updated", "todo.archived",
    ]);
    await assert.rejects(f.service.delete(f.update.taskId), {
        code: "todo.commitDurabilityUnconfirmed",
    });
    assert.deepEqual(await f.service.read({ taskId: f.update.taskId }), {
        items: [], revision: 0, summary: { completed: 0, total: 0 },
    });
    assert.deepEqual(await f.service.read(), await f.fresh().read());
    assert.equal(f.events.at(-1)?.type, "todo.deleted");
    assert.equal(f.events.length, 5);
});

test("TodoStore.write reconciles the direct persistence path after a directory fsync error", {
    skip: process.platform === "win32",
}, async (t) => {
    const f = await fixture(t);
    const state = new TodoState("alpha");
    const store = new TodoStore({ filePath: f.filePath, instanceName: "alpha", state });
    const next = state.transition(store.read(), f.changed, "ctx-b");
    failDirectorySync(t, f.root);
    await assert.rejects(store.write(next.document), { code: "todo.commitDurabilityUnconfirmed" });
    assert.deepEqual(store.read(), next.document);
    assert.deepEqual(store.reload(), next.document);
});

test("TodoService rejects pre-fix duplicate-title v4 data without deleting or normalizing tasks", async () => {
    const root = await createTestTempDirectory("todo-old-duplicates");
    const filePath = join(root, "todo.json");
    let sequence = 0;
    const state = new TodoState("alpha", { taskId: () => `task-${++sequence}` });
    const first = state.transition(state.emptyDocument(), plan, "ctx-a");
    const second = state.transition(first.document, { ...plan, title: "Other" }, "ctx-b");
    const damaged = structuredClone(second.document);
    damaged.active[1]!.title = plan.title;
    const bytes = `${JSON.stringify(damaged)}\n`;
    await promises.writeFile(filePath, bytes);
    const service = new TodoService({
        filePath, instanceName: "alpha", async appendEvent() {},
    });
    await assert.rejects(service.read(), {
        code: "todo.invalid",
        causeBody: {
            code: "error.unknown", message: "active todo titles must be unique", retryable: false,
        },
    });
    await assert.rejects(service.write(plan, "ctx-c"), { code: "todo.invalid" });
    assert.equal(await promises.readFile(filePath, "utf8"), bytes);
    assert.deepEqual(damaged.active.map((entry) => entry.taskId), ["task-1", "task-2"]);
    assert.deepEqual(damaged.active.map((entry) => entry.activeCtxId), ["ctx-a", "ctx-b"]);
});
