import assert from "node:assert/strict";
import test from "node:test";

import { McpToolDescriptionEnhancer, McpToolFilter, McpToolSchemaAdapter } from "@portable-devshell/mcp";

test("McpToolFilter applies group and capability policy against worker tool cache", () => {
    const filter = new McpToolFilter({ capabilities: ["execute"], groups: ["bash"] });
    const filtered = filter.filter([
        { access: "execute", group: "bash", name: "bash_run", description: "Run shell", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
        { access: "read", group: "file", name: "file_read", description: "Read file", inputSchema: { type: "object" }, outputSchema: { type: "object" } }
    ]);

    assert.deepEqual(filtered.map((tool) => tool.name), ["bash_run"]);
});

test("McpToolFilter returns no tools when policy is empty", () => {
    const filter = new McpToolFilter({ capabilities: [], groups: [] });
    const filtered = filter.filter([
        { access: "execute", group: "bash", name: "bash_run", description: "Run shell", inputSchema: { type: "object" }, outputSchema: { type: "object" } }
    ]);

    assert.deepEqual(filtered, []);
});

test("McpToolDescriptionEnhancer appends MCP exposure note", () => {
    const enhancer = new McpToolDescriptionEnhancer();
    assert.match(enhancer.enhance("Run shell"), /Run shell/u);
});

test("McpToolSchemaAdapter rejects missing schema", () => {
    const adapter = new McpToolSchemaAdapter();
    assert.throws(
        () => adapter.toMcpTool({ access: "execute", group: "bash", name: "bash_run", description: "Run shell", inputSchema: undefined, outputSchema: {} } as never, "Run shell"),
        /Tool schema unavailable/u
    );
});
