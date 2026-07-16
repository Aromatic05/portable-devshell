import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TodoState } from "../../dist/instance/todo/TodoState.js";
import { TodoStore } from "../../dist/instance/todo/TodoStore.js";

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

    assert.equal(created.document.active?.taskId, "task-fixed");
    assert.deepEqual(created.events.map((event) => event.type), ["todo.created"]);
    assert.deepEqual(state.readResult(created.document), {
        items: [
            { content: "Inspect", id: "inspect", status: "completed" },
            { content: "Implement", id: "implement", status: "in_progress" },
            { content: "Verify", id: "verify", status: "pending" }
        ],
        revision: 1,
        summary: { completed: 1, currentItemId: "implement", total: 3 },
        taskId: "task-fixed",
        title: "Implement"
    });
    assert.equal(state.activeSummary(created.document)?.status, "in_progress");
    assert.deepEqual(state.currentAssociation(created.document), {
        taskId: "task-fixed",
        todoItemId: "implement"
    });
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
            todos: [{ content: "Done", id: "done", status: "completed" }]
        },
        "ctx-1"
    );
    const second = state.transition(
        first.document,
        {
            revision: 0,
            todos: [{ content: "Continue", id: "continue", status: "pending" }]
        },
        "ctx-2"
    );

    assert.equal(second.document.archived.length, 1);
    assert.equal(second.document.archived[0]?.taskId, "task-1");
    assert.equal(second.document.active?.taskId, "task-2");
    assert.deepEqual(second.events.map((event) => event.type), [
        "todo.archived",
        "todo.created"
    ]);
});

test("TodoState rejects invalid item sets and stale revisions", () => {
    const state = new TodoState("aromatic-pc");
    assert.throws(() => state.transition(
        state.emptyDocument(),
        {
            revision: 0,
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
            todos: [{ content: "Blocked", id: "blocked", status: "blocked" }]
        },
        "ctx"
    ));

    const created = state.transition(
        state.emptyDocument(),
        {
            revision: 0,
            todos: [{ content: "Pending", id: "pending", status: "pending" }]
        },
        "ctx"
    );
    assert.throws(() => state.transition(
        created.document,
        {
            revision: 0,
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
    assert.equal(state.readResult(reloaded.read()).summary.currentItemId, "write");
});
