import assert from "node:assert/strict";
import test from "node:test";

import { McpToolCatalogTodo } from "../../../../src/endpoint/domain/task/Catalog.ts";
import { readTodoInput } from "../../../../src/endpoint/domain/task/Input.ts";

test("task todo read selector accepts taskId and the compatibility title selector", () => {
    assert.deepEqual(readTodoInput({ taskId: "task-1" }), { taskId: "task-1" });
    assert.deepEqual(readTodoInput({ title: "Recover" }), { title: "Recover" });
    assert.deepEqual(readTodoInput({ taskId: "  task-2  " }), {
        taskId: "task-2",
    });
    assert.deepEqual(readTodoInput({ title: "  Recover  " }), {
        title: "Recover",
    });
    assert.equal(readTodoInput({}), undefined);
});

test("task todo read selector rejects ambiguous or malformed selectors", () => {
    assert.throws(
        () => readTodoInput(null),
        /todo_read requires an object input/u,
    );
    assert.throws(
        () => readTodoInput([]),
        /todo_read requires an object input/u,
    );
    assert.throws(
        () => readTodoInput({ taskId: "task-1", title: "Recover" }),
        /todo_read accepts only one optional selector: taskId or title/u,
    );
    assert.throws(
        () => readTodoInput({ taskId: "" }),
        /todo_read taskId must be a non-empty string/u,
    );
    assert.throws(
        () => readTodoInput({ title: "   " }),
        /todo_read title must be a non-empty string/u,
    );
});

test("task domain keeps todo as the operation namespace", () => {
    const catalog = new McpToolCatalogTodo();
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
