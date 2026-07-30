import assert from "node:assert/strict";
import test from "node:test";

import { McpToolCatalogTodo } from "../../src/tool/catalog/McpToolCatalogTodo.ts";

test("todo tools document title namespaces and compression recovery", () => {
    const tool = new McpToolCatalogTodo().get("todo_write")!;
    const read = new McpToolCatalogTodo().get("todo_read")!;
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

    assert.match(tool.description, /immutable namespace/u);
    assert.match(tool.description, /context compression/u);
    assert.match(tool.description, /IDs must be unique/u);
    assert.match(tool.description, /pending \| in_progress \| blocked \| completed \| failed \| cancelled/u);
    assert.match(schema.properties.revision.description ?? "", /latest todo_read result/u);
    assert.match(schema.properties.title.description ?? "", /unique among live tasks/u);
    assert.match(schema.properties.todos.description ?? "", /complete replacement list/u);
    assert.match(schema.properties.todos.items.properties.detail.description ?? "", /blocked or failed/u);
    assert.match(read.description, /list all live task titles/u);
});
