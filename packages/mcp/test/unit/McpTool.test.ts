import assert from "node:assert/strict";
import test from "node:test";

import {
    McpToolCatalogEndpoint,
    McpToolDescriptionEnhancer,
    McpToolFilter,
    McpToolSchemaAdapter
} from "@portable-devshell/mcp";
import type { ToolDefinition } from "@portable-devshell/shared";

const bashRun: ToolDefinition = {
    description: "Run shell",
    group: "bash",
    inputSchema: { type: "object" },
    name: "bash_run",
    outputSchema: { type: "object" },
    requiredCapabilities: ["execute"]
};

const todoRead: ToolDefinition = {
    description: "Read Todo",
    group: "todo",
    inputSchema: { type: "object" },
    name: "todo_read",
    outputSchema: { type: "object" },
    requiredCapabilities: []
};

const fileSync: ToolDefinition = {
    description: "Read and write a file",
    group: "file",
    inputSchema: { type: "object" },
    name: "file_sync",
    outputSchema: { type: "object" },
    requiredCapabilities: ["read", "write"]
};

test("McpToolFilter requires the group and every required capability", () => {
    const partial = new McpToolFilter({
        capabilities: ["execute", "read"],
        groups: ["bash", "file", "todo"]
    });
    assert.deepEqual(partial.filter([bashRun, todoRead, fileSync]).map((tool) => tool.name), [
        "bash_run",
        "todo_read"
    ]);

    const complete = new McpToolFilter({
        capabilities: ["read", "write"],
        groups: ["file"]
    });
    assert.deepEqual(complete.filter([bashRun, todoRead, fileSync]).map((tool) => tool.name), ["file_sync"]);
});

test("McpToolFilter allows capability-free tools only when their group is enabled", () => {
    assert.equal(new McpToolFilter({ capabilities: [], groups: ["todo"] }).isAllowed(todoRead), true);
    assert.equal(new McpToolFilter({ capabilities: [], groups: [] }).isAllowed(todoRead), false);
});

test("McpToolCatalogEndpoint merges worker and control tools before applying one policy", () => {
    const catalog = new McpToolCatalogEndpoint({
        capabilities: ["execute"],
        groups: ["bash", "todo"]
    });
    const merged = catalog.merge([
        { owner: "worker", tools: [bashRun] },
        { owner: "todo", tools: [todoRead] },
        { owner: "instance", tools: [] }
    ]);

    assert.deepEqual(catalog.filter(merged).map((entry) => `${entry.owner}:${entry.definition.name}`), [
        "worker:bash_run",
        "todo:todo_read"
    ]);
});

test("McpToolCatalogEndpoint rejects duplicate names across providers", () => {
    const catalog = new McpToolCatalogEndpoint({ capabilities: [], groups: ["todo"] });

    assert.throws(
        () =>
            catalog.merge([
                { owner: "worker", tools: [todoRead] },
                { owner: "todo", tools: [todoRead] }
            ]),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "core.toolSchemaUnavailable");
            return true;
        }
    );
});

test("McpToolDescriptionEnhancer preserves only the supplied description", () => {
    const enhancer = new McpToolDescriptionEnhancer();
    assert.equal(enhancer.enhance("  Run shell  "), "Run shell");
    assert.equal(enhancer.enhance(undefined), "");
});

test("McpToolSchemaAdapter rejects missing schema", () => {
    const adapter = new McpToolSchemaAdapter();
    assert.throws(
        () => adapter.toMcpTool({ ...bashRun, inputSchema: undefined } as never, "Run shell"),
        /Tool schema unavailable/u
    );
});

test("McpToolSchemaAdapter removes non-standard numeric formats", () => {
    const adapter = new McpToolSchemaAdapter();
    const tool = adapter.toMcpTool({
        ...bashRun,
        inputSchema: {
            properties: {
                line: { format: "int64", type: "integer" },
                nested: { items: { format: "uint8", type: ["integer", "null"] }, type: "array" }
            },
            type: "object"
        }
    }, "Run shell");
    assert.deepEqual(tool.inputSchema, {
        properties: {
            line: { type: "integer" },
            nested: { items: { type: ["integer", "null"] }, type: "array" }
        },
        type: "object"
    });
});
