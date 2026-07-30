import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TodoState } from "../../src/instance/todo/TodoState.ts";
import { TodoStore } from "../../src/instance/todo/TodoStore.ts";

test("TodoState owns validation, transitions, summaries, and associations", () => {
    const state = new TodoState("aromatic-pc", {
        now: () => "2026-07-16T00:00:00.000Z",
        taskId: () => "task-fixed"
    });

    const created = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Implement",
            todos: [
                { content: "Inspect", id: "inspect", status: "completed" },
                { content: "Implement", id: "implement", status: "in_progress" },
                { content: "Verify", id: "verify", status: "pending" }
            ]
        },
        "ctx-1"
    );

    assert.equal(created.document.active[0]?.taskId, "task-fixed");
    assert.deepEqual(created.events.map((event) => event.type), ["todo.created"]);
    assert.deepEqual(state.readResult(created.document, "Implement"), {
        items: [
            { content: "Inspect", id: "inspect", status: "completed" },
            { content: "Implement", id: "implement", status: "in_progress" },
            { content: "Verify", id: "verify", status: "pending" }
        ],
        revision: 1,
        summary: { completed: 1, currentItemId: "implement", total: 3 },
        taskId: "task-fixed",
        title: "Implement",
        tasks: [{
            completed: 1,
            ctxId: "ctx-1",
            currentItem: "Implement",
            revision: 1,
            status: "in_progress",
            taskId: "task-fixed",
            title: "Implement",
            total: 3,
            updatedAt: "2026-07-16T00:00:00.000Z"
        }],
        comments: []
    });
    assert.equal(state.activeSummaries(created.document)[0]?.status, "in_progress");
    const parallel = state.transition(
        created.document,
        {
            revision: 0,
            title: "Verify",
            todos: [{ content: "Verify", id: "verify", status: "pending" }]
        },
        "ctx-2"
    ).document;
    assert.deepEqual(state.activeSummaries(parallel).map((summary) => summary.title), ["Implement", "Verify"]);
    assert.deepEqual(state.currentAssociation(created.document, "ctx-1"), {
        taskId: "task-fixed",
        todoItemId: "implement"
    });
});

test("TodoState exposes only actionable work as active todos", () => {
    const state = new TodoState("aromatic-pc", {
        taskId: () => "task-fixed"
    });
    const transition = (status: "cancelled" | "completed" | "failed") => state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Work",
            todos: [{
                content: "Work",
                ...(status === "failed" ? { detail: "Needs attention" } : {}),
                id: "work",
                status
            }]
        },
        "ctx-1"
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
        "2026-07-16T00:02:00.000Z"
    ];
    let task = 0;
    const state = new TodoState("aromatic-pc", {
        now: () => timestamps.shift() ?? "2026-07-16T00:03:00.000Z",
        taskId: () => `task-${++task}`
    });
    const first = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Done",
            todos: [{ content: "Done", id: "done", status: "completed" }]
        },
        "ctx-1"
    );
    const second = state.transition(
        first.document,
        {
            revision: 0,
            title: "Continue",
            todos: [{ content: "Continue", id: "continue", status: "pending" }]
        },
        "ctx-2"
    );

    assert.equal(second.document.archived.length, 1);
    assert.equal(second.document.archived[0]?.taskId, "task-1");
    assert.equal(second.document.active[0]?.taskId, "task-2");
    assert.deepEqual(first.events.map((event) => event.type), ["todo.created", "todo.archived"]);
    assert.deepEqual(second.events.map((event) => event.type), ["todo.created"]);
});

test("TodoState lists live titles and isolates concurrent task revisions", () => {
    let sequence = 0;
    const state = new TodoState("aromatic-pc", { taskId: () => `task-${++sequence}` });
    const first = state.transition(state.emptyDocument(), {
        revision: 0,
        title: "First",
        todos: [{ content: "First work", id: "first", status: "in_progress" }]
    }, "ctx-first");
    const second = state.transition(first.document, {
        revision: 0,
        title: "Second",
        todos: [{ content: "Second work", id: "second", status: "pending" }]
    }, "ctx-second");

    assert.deepEqual(state.readResult(second.document).tasks?.map((task) => task.title), ["First", "Second"]);
    assert.equal(state.readResult(second.document, "First").taskId, "task-1");
    assert.equal(state.currentAssociation(second.document, "ctx-first")?.taskId, "task-1");
    assert.equal(state.currentAssociation(second.document, "ctx-second"), undefined);
});

test("TodoState resolves a unique in-progress association across every task owned by one ctxId", () => {
    let sequence = 0;
    const state = new TodoState("aromatic-pc", { taskId: () => `task-${++sequence}` });
    const pending = state.transition(state.emptyDocument(), {
        revision: 0,
        title: "Pending",
        todos: [{ content: "Pending work", id: "pending", status: "pending" }]
    }, "ctx-shared");
    const active = state.transition(pending.document, {
        revision: 0,
        title: "Active",
        todos: [{ content: "Active work", id: "active", status: "in_progress" }]
    }, "ctx-shared");

    assert.deepEqual(state.currentAssociation(active.document, "ctx-shared"), {
        taskId: "task-2",
        todoItemId: "active"
    });

    const ambiguous = state.transition(active.document, {
        revision: 1,
        title: "Pending",
        todos: [{ content: "Pending work", id: "pending", status: "in_progress" }]
    }, "ctx-shared");
    assert.equal(state.currentAssociation(ambiguous.document, "ctx-shared"), undefined);
});

test("TodoState rejects invalid item sets and stale revisions", () => {
    const state = new TodoState("aromatic-pc");
    assert.throws(() => state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Invalid",
            todos: [
                { content: "One", id: "same", status: "in_progress" },
                { content: "Two", id: "same", status: "in_progress" }
            ]
        },
        "ctx"
    ));
    assert.throws(() => state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Blocked",
            todos: [{ content: "Blocked", id: "blocked", status: "blocked" }]
        },
        "ctx"
    ));

    const created = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            title: "Pending",
            todos: [{ content: "Pending", id: "pending", status: "pending" }]
        },
        "ctx"
    );
    assert.throws(() => state.transition(
        created.document,
        {
            revision: 0,
            title: "Pending",
            todos: [{ content: "Stale", id: "stale", status: "pending" }]
        },
        "ctx"
    ));
});

test("TodoStore persists and reloads normalized state independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-todo-state-"));
    const filePath = join(root, "todo.json");
    const state = new TodoState("aromatic-pc", {
        now: () => "2026-07-16T00:00:00.000Z",
        taskId: () => "task-fixed"
    });
    const store = new TodoStore({ filePath, instanceName: "aromatic-pc", state });
    const transition = state.transition(
        store.read(),
        {
            revision: 0,
            title: "Persist",
            todos: [{ content: "Write", id: "write", status: "in_progress" }]
        },
        "ctx-1"
    );

    await store.write(transition.document);
    const reloaded = new TodoStore({ filePath, instanceName: "aromatic-pc", state });
    assert.deepEqual(reloaded.read(), transition.document);
    assert.equal(state.readResult(reloaded.read(), "Persist").summary.currentItemId, "write");
});


test("TodoStore loads version 1 and version 2 documents as version 3", async () => {
    const { writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-todo-migration-"));
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
        updatedAt: "2026-07-01T00:01:00.000Z"
    };

    const version1Path = join(root, "todo-v1.json");
    const { title: _legacyTitle, ...version1State } = storedState;
    await writeFile(version1Path, JSON.stringify({
        active: version1State,
        archived: [],
        version: 1
    }));
    const version1 = new TodoStore({ filePath: version1Path, instanceName: "aromatic-pc", state }).read();
    assert.equal(version1.version, 3);
    assert.deepEqual(version1.active, [{ ...version1State, title: "task-legacy" }]);
    assert.deepEqual(version1.comments, []);

    const version2Path = join(root, "todo-v2.json");
    await writeFile(version2Path, JSON.stringify({
        active: [storedState],
        archived: [],
        comments: [{
            createdAt: "2026-07-01T00:02:00.000Z",
            id: "comment-legacy",
            text: "Preserve this guidance"
        }],
        version: 2
    }));
    const version2 = new TodoStore({ filePath: version2Path, instanceName: "aromatic-pc", state }).read();
    assert.equal(version2.version, 3);
    assert.deepEqual(version2.active, [storedState]);
    assert.deepEqual(version2.comments, [{
        createdAt: "2026-07-01T00:02:00.000Z",
        ctxId: "ctx-legacy",
        id: "comment-legacy",
        text: "Preserve this guidance"
    }]);
});
