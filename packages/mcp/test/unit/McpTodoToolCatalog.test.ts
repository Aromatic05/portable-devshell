import assert from "node:assert/strict";
import test from "node:test";

import { McpTodoToolCatalog } from "../../dist/mcp/todo/McpTodoToolCatalog.js";

test("todo write documents the complete replacement item contract", () => {
    const tool = new McpTodoToolCatalog().get("todo_write")!;
    const schema = tool.inputSchema as {
        properties: {
            revision: { description?: string };
            title: { description?: string };
            todos: {
                description?: string;
                items: {
                    properties: Record<string, { description?: string }>;
                };
            };
        };
    };

    assert.match(tool.description, /replaces the complete plan/u);
    assert.match(tool.description, /IDs must be unique/u);
    assert.match(tool.description, /pending \| in_progress \| blocked \| completed \| failed \| cancelled/u);
    assert.match(schema.properties.revision.description ?? "", /latest todo_read result/u);
    assert.match(schema.properties.todos.description ?? "", /complete replacement list/u);
    assert.match(schema.properties.todos.items.properties.detail.description ?? "", /blocked or failed/u);
});
