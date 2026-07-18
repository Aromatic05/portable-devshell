import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TodoService } from "../../src/instance/todo/TodoService.ts";

test("TodoService creates, validates revisions, persists atomically, and emits derived summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-todo-"));
    const filePath = join(root, "todo.json");
    const events: Array<{ type: string; data: unknown }> = [];
    const service = new TodoService({
        appendEvent: async (type, data) => {
            events.push({ data, type });
        },
        filePath,
        instanceName: "aromatic-pc",
    });

    assert.deepEqual(await service.read(), {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 },
    });

    const created = await service.write(
        {
            revision: 0,
            title: "Implement todo",
            todos: [
                { content: "Inspect", id: "inspect", status: "completed" },
                {
                    content: "Implement",
                    detail: "Editing service",
                    id: "implement",
                    status: "in_progress",
                },
                { content: "Verify", id: "verify", status: "pending" },
            ],
        },
        "mcp-session",
    );

    assert.equal(created.revision, 1);
    assert.equal(created.summary.completed, 1);
    assert.equal(created.summary.total, 3);
    assert.equal(created.summary.currentItemId, "implement");
    assert.equal(service.currentAssociation()?.todoItemId, "implement");
    assert.equal(events[0]?.type, "todo.created");

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
        active: { revision: number };
    };
    assert.equal(persisted.active.revision, 1);

    await assert.rejects(
        service.write(
            {
                revision: 0,
                todos: [{ content: "Stale", id: "stale", status: "pending" }],
            },
            "mcp-session",
        ),
        (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "todo.revisionConflict",
    );
});

test("TodoService rejects duplicate ids, multiple in-progress items, and missing failure detail", async () => {
    const root = await mkdtemp(
        join(tmpdir(), "portable-devshell-todo-invalid-"),
    );
    const service = new TodoService({
        appendEvent: async () => undefined,
        filePath: join(root, "todo.json"),
        instanceName: "aromatic-pc",
    });

    await assert.rejects(
        service.write(
            {
                revision: 0,
                todos: [
                    { content: "One", id: "same", status: "in_progress" },
                    { content: "Two", id: "same", status: "in_progress" },
                ],
            },
            "session",
        ),
    );

    await assert.rejects(
        service.write(
            {
                revision: 0,
                todos: [
                    { content: "Blocked", id: "blocked", status: "blocked" },
                ],
            },
            "session",
        ),
    );
});

test("TodoService emits terminal events once, archives terminal tasks, and reloads persisted state", async () => {
    const root = await mkdtemp(
        join(tmpdir(), "portable-devshell-todo-archive-"),
    );
    const filePath = join(root, "todo.json");
    const eventTypes: string[] = [];
    const createService = () =>
        new TodoService({
            appendEvent: async (type) => {
                eventTypes.push(type);
            },
            filePath,
            instanceName: "aromatic-pc",
        });
    const service = createService();

    const created = await service.write(
        {
            revision: 0,
            title: "First task",
            todos: [{ content: "Finish", id: "finish", status: "pending" }],
        },
        "session-1",
    );
    await service.write(
        {
            revision: created.revision,
            title: "First task",
            todos: [{ content: "Finish", id: "finish", status: "completed" }],
        },
        "session-1",
    );
    const next = await service.write(
        {
            revision: 0,
            title: "Second task",
            todos: [
                { content: "Continue", id: "continue", status: "in_progress" },
            ],
        },
        "session-2",
    );

    assert.deepEqual(eventTypes, [
        "todo.created",
        "todo.completed",
        "todo.archived",
        "todo.created",
    ]);
    assert.equal(next.revision, 1);
    assert.equal(next.title, "Second task");

    const reloaded = createService();
    assert.deepEqual(await reloaded.read(), next);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
        archived: unknown[];
    };
    assert.equal(persisted.archived.length, 1);
});
