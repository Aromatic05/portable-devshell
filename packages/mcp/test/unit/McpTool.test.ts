import assert from "node:assert/strict";
import test from "node:test";

import {
    McpToolCatalogEndpoint,
    McpToolDescriptionEnhancer,
    McpToolFilter,
    McpToolSchemaAdapter,
    mcpToolAnnotations
} from "@portable-devshell/mcp/testing";
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

test("MCP safety annotations are explicit for known semantics and conservative for unknown tools", () => {
    assert.deepEqual(mcpToolAnnotations("file_read"), {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
    });
    assert.deepEqual(mcpToolAnnotations("tmux_read"), {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("instance_connect"), {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("todo_write"), {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("workspace_approval_decide"), {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("future_unknown_tool"), {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
    });
});

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

test("McpToolSchemaAdapter flattens referenced object unions for MCP clients", () => {
    const adapter = new McpToolSchemaAdapter();
    const tool = adapter.toMcpTool({
        ...bashRun,
        inputSchema: {
            $defs: {
                Pane: {
                    additionalProperties: false,
                    properties: {
                        ctxId: { type: "string" },
                        input: { type: "string" },
                        pane: { type: "string" }
                    },
                    required: ["pane", "input", "ctxId"],
                    type: "object"
                },
                Task: {
                    additionalProperties: false,
                    properties: {
                        ctxId: { type: "string" },
                        input: { type: "string" },
                        task: { type: "string" }
                    },
                    required: ["task", "input", "ctxId"],
                    type: "object"
                }
            },
            anyOf: [{ $ref: "#/$defs/Task" }, { $ref: "#/$defs/Pane" }]
        }
    }, "Run shell");
    const schema = tool.inputSchema as {
        anyOf?: unknown;
        properties?: Record<string, unknown>;
        required?: string[];
        type?: string;
    };
    assert.equal(schema.anyOf, undefined);
    assert.equal(schema.type, "object");
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["ctxId", "input", "pane", "task"]);
    assert.deepEqual(schema.required, ["input", "ctxId"]);
});

test("McpToolSchemaAdapter removes model-unsupported composition constraints recursively", () => {
    const adapter = new McpToolSchemaAdapter();
    const tool = adapter.toMcpTool({
        ...bashRun,
        inputSchema: {
            additionalProperties: false,
            properties: {
                items: {
                    contains: { properties: { status: { const: "active" } }, type: "object" },
                    items: {
                        additionalProperties: false,
                        allOf: [{
                            if: { properties: { status: { const: "blocked" } } },
                            then: { required: ["detail"] }
                        }],
                        properties: {
                            detail: { type: "string" },
                            id: { type: "string" },
                            status: { enum: ["active", "blocked"], type: "string" }
                        },
                        required: ["id", "status"],
                        type: "object"
                    },
                    maxContains: 1,
                    minContains: 0,
                    type: "array"
                }
            },
            required: ["items"],
            type: "object"
        },
        outputSchema: {
            additionalProperties: false,
            properties: {
                source: {
                    additionalProperties: false,
                    oneOf: [
                        { not: { required: ["path"] }, required: ["handle"] },
                        { not: { required: ["handle"] }, required: ["path"] }
                    ],
                    properties: {
                        handle: { type: "string" },
                        path: { type: "string" }
                    },
                    type: "object"
                }
            },
            required: ["source"],
            type: "object"
        }
    }, "Run shell");

    const input = tool.inputSchema as {
        properties?: { items?: { contains?: unknown; items?: Record<string, unknown>; maxContains?: unknown; minContains?: unknown } };
    };
    const item = input.properties?.items?.items;
    assert.notEqual(item, undefined);
    assert.equal(item?.allOf, undefined);
    assert.deepEqual(Object.keys((item?.properties as Record<string, unknown>) ?? {}).sort(), ["detail", "id", "status"]);
    assert.equal(input.properties?.items?.contains, undefined);
    assert.equal(input.properties?.items?.minContains, undefined);
    assert.equal(input.properties?.items?.maxContains, undefined);

    const output = tool.outputSchema as { properties?: { source?: Record<string, unknown> } };
    assert.equal(output.properties?.source?.oneOf, undefined);
    assert.deepEqual(Object.keys((output.properties?.source?.properties as Record<string, unknown>) ?? {}).sort(), ["handle", "path"]);
});
