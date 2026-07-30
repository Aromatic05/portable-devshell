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
    assert.equal(state.activeSummary(created.document)?.status, "in_progress");
    assert.deepEqual(state.currentAssociation(created.document, "ctx-1"), {
        taskId: "task-fixed",
        todoItemId: "implement"
    });
});

test("TodoState exposes only actionable work as activeTodo", () => {
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
    assert.equal(state.activeSummary(completed), undefined);
    assert.equal(state.readResult(completed).taskId, undefined);
    assert.equal(state.activeSummary(transition("cancelled")), undefined);
    assert.equal(state.activeSummary(transition("failed")), undefined);
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
