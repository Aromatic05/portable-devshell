import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, type JsonValue } from "@portable-devshell/shared";
import { TodoToolDefinitions } from "../../../src/task/todo/tool/Definition.ts";
import { readTodoToolInput } from "../../../src/task/todo/tool/Input.ts";
import type {
    ToolCallExecutor,
    ToolCallHooks,
} from "../../../src/toolcall/Api.ts";

test("task todo read selector accepts taskId and rejects title selectors", () => {
    assert.deepEqual(readTodoToolInput({ taskId: "task-1" }), { taskId: "task-1" });
    assert.deepEqual(readTodoToolInput({ taskId: "  task-2  " }), {
        taskId: "task-2",
    });
    assert.equal(readTodoToolInput({}), undefined);
    assert.throws(
        () => readTodoToolInput({ title: "Recover" }),
        /accepts only taskId/u,
    );
});

test("task todo read selector rejects ambiguous or malformed selectors", () => {
    assert.throws(
        () => readTodoToolInput(null),
        /todo_read requires an object input/u,
    );
    assert.throws(
        () => readTodoToolInput([]),
        /todo_read requires an object input/u,
    );
    assert.throws(
        () => readTodoToolInput({ taskId: "task-1", title: "Recover" }),
        /accepts only taskId/u,
    );
    assert.throws(
        () => readTodoToolInput({ taskId: "" }),
        /todo_read taskId must be a non-empty string/u,
    );
    assert.throws(
        () => readTodoToolInput({ title: "   " }),
        /accepts only taskId/u,
    );
});

test("todo_read validates paging without requiring a taskId", () => {
    assert.deepEqual(readTodoToolInput({ offset: 20, limit: 5 }), {
        offset: 20, limit: 5,
    });
    assert.deepEqual(readTodoToolInput({ taskId: "  task-3  ", offset: 10 }), {
        taskId: "task-3", offset: 10,
    });
    const invalid: JsonValue[] = [
        { offset: -1 }, { offset: 1.5 }, { limit: 0 },
        { limit: 101 }, { limit: "10" },
    ];
    for (const input of invalid) assert.throws(() => readTodoToolInput(input));
});

test("task domain keeps todo as the operation namespace", () => {
    const catalog = new TodoToolDefinitions();
    assert.deepEqual(
        catalog
            .list()
            .map((definition) => definition.name)
            .sort(),
        ["todo_read", "todo_write"],
    );
    for (const definition of catalog.list()) {
        assert.equal(definition.group, "todo");
    }
    assert.equal(catalog.isTodoTool("todo_read"), true);
    assert.equal(catalog.isTodoTool("todo_write"), true);
    assert.equal(catalog.isTodoTool("task_read"), false);
});

import type { TaskApi } from "../../../src/task/Api.ts";
import { installTodoTools } from "../../../src/task/todo/tool/Runtime.ts";

test("Todo tools execute against the provided TaskApi", async () => {
    const instanceName = asInstanceName("local");
    const executes = new Map<string, ToolCallExecutor>();
    const hooks: ToolCallHooks = {
        registerContributor() {
            return () => undefined;
        },
        registerExecute: (
            name: string,
            execute: ToolCallExecutor,
        ) => {
            executes.set(name, execute);
            return () => executes.delete(name);
        },
        registerReview() {
            return () => undefined;
        },
    };
    let writtenCtxId: string | undefined;
    const task = {
        todo: {
            async read() {
                return {
                    items: [],
                    revision: 0,
                    summary: { completed: 0, total: 0 },
                    tasks: Array.from({ length: 45 }, (_, i) => ({
                        completed: 0,
                        revision: 0,
                        status: "pending",
                        taskId: `task-${i}`,
                        title: `Task ${i}`,
                        total: 1,
                        updatedAt: "2026-10-13T00:00:00Z",
                    })),
                };
            },
            async write(_input: unknown, ctxId: string) {
                writtenCtxId = ctxId;
                return {
                    items: [
                        { content: "done", id: "1", status: "completed" },
                    ],
                    revision: 1,
                    summary: { completed: 1, total: 1 },
                    taskId: "task-1",
                    title: "Task",
                };
            },
        },
        wait: {
            async list() {
                return [];
            },
        },
    } as unknown as TaskApi;

    const uninstall = installTodoTools(hooks, task);
    try {
        const read = executes.get("todo_read");
        const write = executes.get("todo_write");
        assert.ok(read);
        assert.ok(write);
        const readResult = await read(
            "read-1",
            {},
            {
                context: { instance: instanceName, source: "mcp" },
                kind: "call",
                payload: {},
                toolName: "todo_read",
            },
        );
        assert.equal(
            (readResult as { revision?: number }).revision,
            0,
        );
        const first = readResult as { tasks?: Array<{ taskId: string }>; nextOffset?: number };
        assert.equal(first.tasks?.length, 20);
        assert.equal(first.nextOffset, 20);
        const second = await read("read-2", { offset: 20, limit: 15 }, {
            context: { instance: instanceName, source: "mcp" },
            kind: "call",
            payload: { offset: 20, limit: 15 },
            toolName: "todo_read",
        }) as { tasks?: Array<{ taskId: string }>; nextOffset?: number };
        assert.equal(second.tasks?.length, 15);
        assert.equal(second.tasks?.[0]?.taskId, "task-20");
        assert.equal(second.nextOffset, 35);
        const written = await write(
            "write-1",
            { revision: 0, title: "Task", todos: [] },
            {
                context: {
                    ctxId: "ctx-1",
                    instance: instanceName,
                    source: "mcp",
                },
                kind: "call",
                payload: { revision: 0, title: "Task", todos: [] },
                toolName: "todo_write",
            },
        );
        assert.equal(writtenCtxId, "ctx-1");
        assert.deepEqual(written, {
            revision: 1,
            summary: { completed: 1, total: 1 },
            taskId: "task-1",
            title: "Task",
        });
    } finally {
        uninstall();
    }
    assert.equal(executes.get("todo_read"), undefined);
    assert.equal(executes.get("todo_write"), undefined);
});
