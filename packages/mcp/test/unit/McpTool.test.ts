import assert from "node:assert/strict";
import test from "node:test";

import { McpToolDescriptionEnhancer, McpToolFilter, McpToolSchemaAdapter, McpToolSchemaUnavailableError } from "@portable-devshell/mcp";

test("McpToolFilter applies allowlist against worker tool cache", () => {
    const filter = new McpToolFilter(["bash_run"]);

    const result = filter.filter([
        { name: "bash_run", description: "Run shell", inputSchema: { type: "object" } },
        { name: "read_logs", description: "Read logs", inputSchema: { type: "object" } }
    ]);

    assert.deepEqual(result.map((tool) => tool.name), ["bash_run"]);
});

test("McpToolFilter returns no tools when allowlist is empty", () => {
    const filter = new McpToolFilter([]);

    const result = filter.filter([
        { name: "bash_run", description: "Run shell", inputSchema: { type: "object" } },
        { name: "read_logs", description: "Read logs", inputSchema: { type: "object" } }
    ]);

    assert.deepEqual(result, []);
});

test("McpToolDescriptionEnhancer appends MCP exposure note", () => {
    const enhancer = new McpToolDescriptionEnhancer();
    assert.equal(enhancer.enhance("Run shell"), "Run shell Exposed by portable-devshell MCP.");
});

test("McpToolSchemaAdapter rejects missing schema", () => {
    const adapter = new McpToolSchemaAdapter();

    assert.throws(
        () => adapter.toMcpTool({ name: "bash_run", description: "Run shell", inputSchema: undefined }, "Run shell"),
        (error: unknown) => error instanceof McpToolSchemaUnavailableError && error.code === "mcp.toolSchemaUnavailable"
    );
});
