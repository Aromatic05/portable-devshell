import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

import { join } from "node:path";
import test from "node:test";

import { TodoState } from "../../../../src/task/todo/Store.ts";
import { TodoStore } from "../../../../src/task/todo/Store.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

test("TodoState owns validation, transitions, and summaries", () => {
    const state = new TodoState("aromatic-pc", {
        now: () => "2026-07-16T00:00:00.000Z",
        taskId: () => "task-fixed",
    });

    const created = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Implement",
            todos: [
                { content: "Inspect", id: "inspect", status: "completed" },
                {
                    content: "Implement",
                    id: "implement",
                    status: "in_progress",
                },
                { content: "Verify", id: "verify", status: "pending" },
            ],
        },
        "ctx-1",
    );

    assert.equal(created.document.active[0]?.taskId, "task-fixed");
    assert.deepEqual(
        created.events.map((event) => event.type),
        ["todo.created"],
    );
    assert.equal(
        (created.events[0]?.data as { ctxId?: string }).ctxId,
        "ctx-1",
    );
    assert.deepEqual(
        state.readResult(created.document, { taskId: "task-fixed" }),
        {
            items: [
                { content: "Inspect", id: "inspect", status: "completed" },
                { content: "Implement", id: "implement", status: "in_progress" },
                { content: "Verify", id: "verify", status: "pending" },
            ],
            revision: 1,
            summary: { completed: 1, currentItemId: "implement", total: 3 },
            taskId: "task-fixed",
            title: "Implement",
        },
    );
    assert.equal(
        "tasks" in state.readResult(created.document, { taskId: "task-fixed" }),
        false,
    );
    assert.equal(
        "tasks" in
            state.readResult(created.document, { taskId: "task-missing" }),
        false,
    );
    assert.deepEqual(
        state.readResult(created.document).tasks?.map((task) => task.taskId),
        ["task-fixed"],
    );
    assert.equal(
        state.activeSummaries(created.document)[0]?.status,
        "in_progress",
    );
    const parallel = state.transition(
        created.document,
        {
            revision: 0,
            title: "Verify",
            todos: [{ content: "Verify", id: "verify", status: "pending" }],
        },
        "ctx-2",
    ).document;
    assert.deepEqual(
        state.activeSummaries(parallel).map((summary) => summary.title),
        ["Implement", "Verify"],
    );
});

test("TodoState reads and updates an existing task by stable taskId", () => {
    const state = new TodoState("aromatic-pc", { taskId: () => "task-fixed" });
    const created = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Stable task",
            todos: [{ content: "First", id: "first", status: "in_progress" }],
        },
        "ctx-first",
    );

    assert.equal(
        state.readResult(created.document, { taskId: "task-fixed" }).title,
        "Stable task",
    );
    const updated = state.transition(
        created.document,
        {
            revision: 1,
            taskId: "task-fixed",
            title: "Stable task",
            todos: [{ content: "Second", id: "second", status: "in_progress" }],
        },
        "ctx-second",
    );

    assert.deepEqual(
        state.readResult(updated.document, { taskId: "task-fixed" }).items,
        [{ content: "Second", id: "second", status: "in_progress" }],
    );
    assert.equal(updated.document.active[0]?.activeCtxId, "ctx-second");
    assert.throws(
        () =>
            state.transition(
                updated.document,
                {
                    revision: 2,
                    taskId: "task-missing",
                    title: "Stable task",
                    todos: [],
                },
                "ctx-third",
            ),
        /task-missing.*not found/,
    );
});

test("TodoState persists checkpoints and task controls model re-entry without rewriting items", () => {
    const times = [
        "2026-08-19T01:00:00.000Z",
        "2026-08-19T01:01:00.000Z",
        "2026-08-19T01:02:00.000Z",
        "2026-08-19T01:03:00.000Z",
        "2026-08-19T01:04:00.000Z",
    ];
    const state = new TodoState("aromatic-pc", {
        now: () => times.shift() ?? "2026-08-19T01:05:00.000Z",
        taskId: () => "task-fixed",
    });
    const items = [
        { content: "Done", id: "done", status: "completed" as const },
        { content: "Continue", id: "continue", status: "in_progress" as const },
    ];
    const created = state.transition(
        state.emptyDocument(),
        {
            checkpoint: {
                next: "Continue implementation",
                summary: "Core path is ready",
            },
            revision: 0,
            title: "Checkpointed",
            todos: items,
        },
        "ctx-1",
    );

    assert.deepEqual(
        state.readResult(created.document, { taskId: "task-fixed" }).checkpoint,
        {
            next: "Continue implementation",
            summary: "Core path is ready",
            updatedAt: "2026-08-19T01:00:00.000Z",
        },
    );

    assert.throws(
        () =>
            state.control(created.document, "task-fixed", "pause", "ctx-1", 2),
        /changed from revision 2 to 1/u,
    );
    const paused = state.control(
        created.document,
        "task-fixed",
        "pause",
        "ctx-1",
        1,
    );
    assert.equal(
        state.readResult(paused.document).tasks?.[0]?.status,
        "paused",
    );
    assert.deepEqual(paused.document.active[0]?.items, items);

    const resumed = state.control(
        paused.document,
        "task-fixed",
        "resume",
        "ctx-2",
        2,
    );
    assert.equal(
        state.readResult(resumed.document).tasks?.[0]?.status,
        "in_progress",
    );
    const updated = state.transition(
        resumed.document,
        {
            revision: 3,
            taskId: "task-fixed",
            title: "Checkpointed",
            todos: items,
        },
        "ctx-2",
    );
    assert.equal(
        state.readResult(updated.document, { taskId: "task-fixed" }).checkpoint
            ?.summary,
        "Core path is ready",
    );
    assert.equal(updated.document, resumed.document);
    assert.deepEqual(updated.events, []);

    const cancelled = state.control(
        updated.document,
        "task-fixed",
        "cancel",
        "ctx-2",
        3,
    );
    const archived = state.readResult(cancelled.document, {
        taskId: "task-fixed",
    });
    assert.equal(cancelled.document.active.length, 0);
    assert.equal(cancelled.document.archived.length, 1);
    assert.equal(archived.checkpoint?.summary, "Core path is ready");
    assert.equal(archived.cancelledAt, "2026-08-19T01:03:00.000Z");
    assert.deepEqual(archived.items, items);
});

test("TodoState exposes only actionable work as active todos", () => {
    const state = new TodoState("aromatic-pc", {
        taskId: () => "task-fixed",
    });
    const transition = (status: "cancelled" | "completed" | "failed") =>
        state.transition(
            state.emptyDocument(),
            {
                revision: 0,
                title: "Work",
                todos: [
                    {
                        content: "Work",
                        ...(status === "failed"
                            ? { detail: "Needs attention" }
                            : {}),
                        id: "work",
                        status,
                    },
                ],
            },
            "ctx-1",
        ).document;

    const completed = transition("completed");
    assert.deepEqual(state.activeSummaries(completed), []);
    assert.equal(state.readResult(completed).taskId, undefined);
    assert.deepEqual(state.activeSummaries(transition("cancelled")), []);
    assert.deepEqual(state.activeSummaries(transition("failed")), []);
});

test("TodoState archives terminal work before creating a replacement task", () => {
    const timestamps = [
        "2026-07-16T00:00:00.000Z",
        "2026-07-16T00:01:00.000Z",
        "2026-07-16T00:02:00.000Z",
    ];
    let task = 0;
    const state = new TodoState("aromatic-pc", {
        now: () => timestamps.shift() ?? "2026-07-16T00:03:00.000Z",
        taskId: () => `task-${++task}`,
    });
    const first = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Done",
            todos: [{ content: "Done", id: "done", status: "completed" }],
        },
        "ctx-1",
    );
    const second = state.transition(
        first.document,
        {
            revision: 0,
            title: "Continue",
            todos: [{ content: "Continue", id: "continue", status: "pending" }],
        },
        "ctx-2",
    );

    assert.equal(second.document.archived.length, 1);
    assert.equal(second.document.archived[0]?.taskId, "task-1");
    assert.equal(second.document.active[0]?.taskId, "task-2");
    assert.deepEqual(
        first.events.map((event) => event.type),
        ["todo.created", "todo.archived"],
    );
    assert.deepEqual(
        second.events.map((event) => event.type),
        ["todo.created"],
    );
});

test("TodoState lists live titles and isolates concurrent task revisions", () => {
    let sequence = 0;
    const state = new TodoState("aromatic-pc", {
        taskId: () => `task-${++sequence}`,
    });
    const first = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "First",
            todos: [
                { content: "First work", id: "first", status: "in_progress" },
            ],
        },
        "ctx-first",
    );
    const second = state.transition(
        first.document,
        {
            revision: 0,
            title: "Second",
            todos: [
                { content: "Second work", id: "second", status: "pending" },
            ],
        },
        "ctx-second",
    );

    assert.deepEqual(
        state.readResult(second.document).tasks?.map((task) => task.title),
        ["First", "Second"],
    );
    assert.equal(
        state.readResult(second.document, { taskId: "task-1" }).taskId,
        "task-1",
    );
});

test("TodoState rejects invalid item sets and stale revisions", () => {
    const state = new TodoState("aromatic-pc");
    assert.throws(() =>
        state.transition(
            state.emptyDocument(),
            {
                revision: 0,
                title: "Invalid",
                todos: [
                    { content: "One", id: "same", status: "in_progress" },
                    { content: "Two", id: "same", status: "in_progress" },
                ],
            },
            "ctx",
        ),
    );
    assert.throws(() =>
        state.transition(
            state.emptyDocument(),
            {
                revision: 0,
                title: "Blocked",
                todos: [
                    { content: "Blocked", id: "blocked", status: "blocked" },
                ],
            },
            "ctx",
        ),
    );

    const created = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Pending",
            todos: [{ content: "Pending", id: "pending", status: "pending" }],
        },
        "ctx",
    );
    assert.throws(() =>
        state.transition(
            created.document,
            {
                revision: 0,
                taskId: created.document.active[0]?.taskId,
                title: "Pending",
                todos: [{ content: "Stale", id: "stale", status: "pending" }],
            },
            "ctx",
        ),
    );
});

test("TodoStore persists and reloads normalized state independently", async () => {
    const root = await createTestTempDirectory("todo-state");
    const filePath = join(root, "todo.json");
    const state = new TodoState("aromatic-pc", {
        now: () => "2026-07-16T00:00:00.000Z",
        taskId: () => "task-fixed",
    });
    const store = new TodoStore({
        filePath,
        instanceName: "aromatic-pc",
        state,
    });
    const transition = state.transition(
        store.read(),
        {
            revision: 0,
            title: "Persist",
            todos: [{ content: "Write", id: "write", status: "in_progress" }],
        },
        "ctx-1",
    );

    await store.write(transition.document);
    const reloaded = new TodoStore({
        filePath,
        instanceName: "aromatic-pc",
        state,
    });
    assert.deepEqual(reloaded.read(), transition.document);
    assert.equal(
        state.readResult(reloaded.read(), { taskId: "task-fixed" }).summary
            .currentItemId,
        "write",
    );
});

test("TodoStore rejects duplicate active titles before writing and remains readable after restart", async () => {
    const root = await createTestTempDirectory("todo-duplicate-title");
    const filePath = join(root, "todo.json");
    let sequence = 0;
    const state = new TodoState("aromatic-pc", {
        taskId: () => `task-${++sequence}`,
    });
    const store = new TodoStore({ filePath, instanceName: "aromatic-pc", state });
    const firstInput = {
        revision: 0,
        title: "Duplicate active title",
        todos: [{ content: "First work", id: "first", status: "pending" as const }],
    };
    const write = (input: Parameters<TodoState["transition"]>[1]) =>
        store.transition((document) => {
            const transition = state.transition(document, input, "ctx-1");
            return { document: transition.document, result: transition };
        });
    const first = await write(firstInput);
    const second = await write({
        revision: 0,
        title: "Distinct active title",
        todos: [{ content: "Second work", id: "second", status: "pending" }],
    });
    assert.notEqual(first.taskId, second.taskId);
    const before = store.read();
    const bytes = await readFile(filePath, "utf8");
    const inode = (await stat(filePath)).ino;

    await assert.rejects(write({ ...firstInput, title: " Duplicate active title " }), {
        code: "todo.invalid",
        message: /active todo title.*already exists/u,
    });
    assert.equal(await readFile(filePath, "utf8"), bytes);
    assert.equal((await stat(filePath)).ino, inode);
    assert.deepEqual(store.read(), before);
    const restarted = new TodoStore({
        filePath,
        instanceName: "aromatic-pc",
        state: new TodoState("aromatic-pc"),
    });
    assert.deepEqual(restarted.read(), before);
    assert.throws(
        () => state.normalizeDocument({ ...before, active: [...before.active, before.active[0]] }),
        /active todo titles must be unique/u,
    );

    await assert.rejects(write({ ...firstInput, taskId: first.taskId }), {
        code: "todo.revisionConflict",
    });
    assert.equal(await readFile(filePath, "utf8"), bytes);
    const updated = await write({
        ...firstInput,
        revision: 1,
        taskId: first.taskId,
        todos: [{ content: "Finished first work", id: "first", status: "completed" }],
    });
    assert.equal(updated.document.archived[0]?.revision, 2);
    assert.equal(updated.document.active[0]?.taskId, second.taskId);
    assert.equal(updated.document.active[0]?.revision, 1);
    const replacement = await write(firstInput);
    assert.notEqual(replacement.taskId, first.taskId);
    assert.equal(replacement.document.archived[0]?.taskId, first.taskId);
    assert.deepEqual(restarted.reload(), replacement.document);
});

test("TodoStore exact plan updates preserve revision 256, timestamps, events, and the atomic file", async () => {
    const root = await createTestTempDirectory("todo-noop");
    const filePath = join(root, "todo.json");
    let now = "2026-08-19T01:00:00.000Z";
    const state = new TodoState("aromatic-pc", {
        now: () => now,
        taskId: () => "task-fixed",
    });
    const store = new TodoStore({ filePath, instanceName: "aromatic-pc", state });
    const input = {
        revision: 0,
        title: "Stable plan",
        todos: [{ content: "Continue", id: "continue", status: "in_progress" as const }],
    };
    const created = state.transition(state.emptyDocument(), {
        ...input,
        checkpoint: { summary: "Ready", next: "Continue" },
    }, "ctx-1");
    const seeded = structuredClone(created.document);
    seeded.active[0]!.revision = 256;
    await store.write(seeded);
    const before = store.read();
    const bytes = await readFile(filePath, "utf8");
    const inode = (await stat(filePath)).ino;
    const update = { ...input, revision: 256, taskId: created.taskId };
    now = "2026-08-19T01:01:00.000Z";
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const transition = await store.transition((document) => {
            const next = state.transition(document, structuredClone(update), "ctx-1");
            assert.equal(next.document, document);
            return { document: next.document, result: next };
        });
        assert.deepEqual(transition.events, []);
        assert.equal(transition.document.active[0]?.revision, 256);
        assert.deepEqual(store.read(), before);
        assert.equal(await readFile(filePath, "utf8"), bytes);
        assert.equal((await stat(filePath)).ino, inode);
    }
    assert.throws(() => state.transition(before, { ...update, revision: 255 }, "ctx-1"), {
        code: "todo.revisionConflict",
    });

    const handoff = state.transition(before, update, "ctx-2");
    assert.equal(handoff.document.active[0]?.activeCtxId, "ctx-2");
    assert.equal(handoff.document.active[0]?.revision, 257);
    assert.equal(handoff.document.active[0]?.updatedAt, now);
    assert.deepEqual(handoff.document.active[0]?.checkpoint, before.active[0]?.checkpoint);
    assert.deepEqual(handoff.events.map((event) => event.type), ["todo.updated"]);
    now = "2026-08-19T01:02:00.000Z";
    const acknowledged = state.transition(handoff.document, {
        ...update,
        revision: 257,
        checkpoint: { summary: "Ready", next: "Continue" },
    }, "ctx-2");
    assert.equal(acknowledged.document.active[0]?.revision, 258);
    assert.equal(acknowledged.document.active[0]?.checkpoint?.updatedAt, now);
    assert.equal(acknowledged.document.active[0]?.updatedAt, now);
    assert.deepEqual(acknowledged.events.map((event) => event.type), ["todo.updated"]);
    const restarted = new TodoStore({ filePath, instanceName: "aromatic-pc", state });
    assert.deepEqual(restarted.read(), before);
});

test("TodoState treats changes to any item field or plan order as meaningful", () => {
    const state = new TodoState("aromatic-pc", {
        now: () => "2026-08-19T01:00:00.000Z",
        taskId: () => "task-fixed",
    });
    const first = { content: "Inspect", id: "inspect", status: "pending" as const };
    const second = { content: "Verify", id: "verify", status: "pending" as const };
    const created = state.transition(state.emptyDocument(), {
        revision: 0,
        title: "Meaningful changes",
        todos: [first, second],
    }, "ctx-1");
    const changes = [
        [{ ...first, content: "Inspect again" }, second],
        [{ ...first, id: "inspect-again" }, second],
        [{ ...first, detail: "Read the current state" }, second],
        [{ ...first, status: "in_progress" as const }, second],
        [second, first],
    ];
    for (const todos of changes) {
        const updated = state.transition(created.document, {
            revision: 1,
            taskId: created.taskId,
            title: "Meaningful changes",
            todos,
        }, "ctx-1");
        assert.equal(updated.document.active[0]?.revision, 2);
        assert.deepEqual(updated.document.active[0]?.items, todos);
        assert.deepEqual(updated.events.map((event) => event.type), ["todo.updated"]);
    }
});

test("TodoState exact payloads still claim unowned stored tasks and archive terminal active entries", () => {
    const state = new TodoState("aromatic-pc", { taskId: () => "task-fixed" });
    const input = {
        revision: 0,
        title: "Stored task",
        todos: [{ content: "Continue", id: "continue", status: "pending" as const }],
    };
    const created = state.transition(state.emptyDocument(), input, "ctx-1");
    const { activeCtxId: _activeCtxId, ...unowned } = created.document.active[0]!;
    const stored = state.normalizeDocument({
        active: [unowned], archived: [], version: 4,
    });
    const claimed = state.transition(stored, {
        ...input, revision: 1, taskId: created.taskId,
    }, "ctx-1");
    assert.equal(claimed.document.active[0]?.activeCtxId, "ctx-1");
    assert.equal(claimed.document.active[0]?.revision, 2);
    assert.deepEqual(claimed.events.map((event) => event.type), ["todo.updated"]);

    const todos = [{ content: "Continue", id: "continue", status: "completed" as const }];
    const terminal = state.normalizeDocument({
        ...created.document,
        active: [{ ...created.document.active[0], items: todos }],
    });
    const archived = state.transition(terminal, {
        ...input, revision: 1, taskId: created.taskId, todos,
    }, "ctx-1");
    assert.deepEqual(archived.document.active, []);
    assert.equal(archived.document.archived[0]?.revision, 2);
    assert.deepEqual(archived.events.map((event) => event.type), ["todo.updated", "todo.archived"]);
});

test("TodoStore rejects legacy document versions", async () => {
    const { writeFile } = await import("node:fs/promises");
    const root = await createTestTempDirectory("todo-migration");
    const state = new TodoState("aromatic-pc");
    const storedState = {
        activeCtxId: "ctx-legacy",
        createdAt: "2026-07-01T00:00:00.000Z",
        createdByCtxId: "ctx-legacy",
        items: [{ content: "Continue", id: "continue", status: "in_progress" }],
        originInstance: "aromatic-pc",
        revision: 2,
        taskId: "task-legacy",
        title: "Legacy task",
        updatedAt: "2026-07-01T00:01:00.000Z",
    };

    assert.equal("comments" in state.emptyDocument(), false);
    for (const version of [1, 2, 3]) {
        const filePath = join(root, `todo-v${version}.json`);
        await writeFile(
            filePath,
            JSON.stringify({
                active: [storedState],
                archived: [],
                version,
            }),
        );
        assert.throws(
            () =>
                new TodoStore({
                    filePath,
                    instanceName: "aromatic-pc",
                    state,
                }).read(),
            /Todo state for aromatic-pc is invalid/u,
        );
    }

    const version4Path = join(root, "todo-v4.json");
    await writeFile(
        version4Path,
        JSON.stringify({
            active: [storedState],
            archived: [],
            version: 4,
        }),
    );
    const version4 = new TodoStore({
        filePath: version4Path,
        instanceName: "aromatic-pc",
        state,
    }).read();
    assert.equal(version4.version, 4);
    assert.deepEqual(version4.active, [storedState]);

    assert.throws(
        () =>
            state.normalizeDocument({
                active: [storedState],
                archived: [],
                comments: [],
                version: 4,
            }),
        /must not contain comments/u,
    );
});
