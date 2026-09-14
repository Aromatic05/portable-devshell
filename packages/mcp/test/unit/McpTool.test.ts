import assert from "node:assert/strict";
import test from "node:test";

import {
    McpToolCatalogEndpoint,
    McpToolDescriptionEnhancer,
    McpToolSchemaAdapter,
    mcpToolAnnotations,
    mcpToolInvocationStatus,
    mcpToolTitle
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

const environInfo: ToolDefinition = {
    description: "Prepare environment",
    group: "environ",
    inputSchema: { type: "object" },
    name: "environ_info",
    outputSchema: { type: "object" },
    requiredCapabilities: []
};

test("MCP safety annotations are explicit for known semantics and conservative for unknown tools", () => {
    assert.deepEqual(mcpToolAnnotations("file_read"), {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
    });
    assert.deepEqual(mcpToolAnnotations("tmux_read"), {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("tmux_manage"), {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("instance_create"), {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("todo_write"), {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("todo_report"), {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("workspace_approval"), {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    });
    assert.deepEqual(mcpToolAnnotations("future_unknown"), {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
    });
});

test("MCP tools expose concise human-readable titles with a safe fallback", () => {
    assert.equal(mcpToolTitle("bash_run"), "Run shell command");
    assert.equal(mcpToolTitle("workspace_open"), "Open Workspace");
    assert.equal(mcpToolTitle("artifact_viewImage"), "View image");
    assert.equal(mcpToolTitle("tmux_manage"), "Manage tmux resources");
    assert.equal(mcpToolTitle("todo_report"), "Message user");
    assert.equal(mcpToolTitle("future_unknown"), "Future unknown");
});

test("ChatGPT invocation status is limited to long-lived visible tool states", () => {
    assert.deepEqual(mcpToolInvocationStatus("workspace_ask"), {
        invoked: "Answer received",
        invoking: "Waiting for your answer…",
    });
    assert.equal(mcpToolInvocationStatus("tmux_run"), undefined);
    assert.deepEqual(mcpToolInvocationStatus("workspace_open"), {
        invoked: "Workspace ready",
        invoking: "Opening Workspace…",
    });
    assert.equal(mcpToolInvocationStatus("file_read"), undefined);
});

test("McpToolCatalogEndpoint enforces namespace groups and reserves environ bootstrap", () => {
    const catalog = new McpToolCatalogEndpoint();
    const environmentEntries = catalog.merge([{ owner: "environment", tools: [environInfo] }]);
    assert.deepEqual(
        environmentEntries.map((entry) => entry.definition.name),
        ["environ_info"]
    );

    assert.throws(
        () => catalog.merge([{ owner: "worker", tools: [{ ...bashRun, group: "file" }] }]),
        /namespace/iu,
    );
    assert.throws(
        () => catalog.merge([{ owner: "worker", tools: [environInfo] }]),
        /reserved.*environ/iu,
    );
});

test("McpToolCatalogEndpoint rejects duplicate names across providers", () => {
    const catalog = new McpToolCatalogEndpoint();

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

test("McpToolDescriptionEnhancer owns concise model-facing guidance", () => {
    const enhancer = new McpToolDescriptionEnhancer();
    const bash = enhancer.enhance("bash_run", "  Worker-neutral shell contract  ");
    assert.match(bash, /tmux_run/u);
    assert.match(bash, /file_read/u);
    assert.notEqual(bash, "Worker-neutral shell contract");
    assert.match(enhancer.enhance("tmux_read", "Worker-neutral tmux contract"), /consume all unread transcript data/u);
    assert.match(enhancer.enhance("tmux_read", "Worker-neutral tmux contract"), /discard the earlier portion/u);
    assert.match(enhancer.enhance("workspace_open", "  Open workspace  "), /environ_info/u);
    assert.match(enhancer.enhance("todo_report", "verbose internal contract"), /#push/u);
    assert.match(enhancer.enhance("todo_report", "verbose internal contract"), /#stop/u);
    assert.equal(enhancer.enhance("future_tool", undefined), "");
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

test("McpToolSchemaAdapter hides tmux_input wait/read fields only from model-facing schema", () => {
    const adapter = new McpToolSchemaAdapter();
    const tmuxInput: ToolDefinition = {
        ...bashRun,
        name: "tmux_input",
        inputSchema: {
            $defs: {
                Pane: {
                    additionalProperties: false,
                    properties: {
                        input: { type: "string" },
                        pane: { type: "string" }
                    },
                    required: ["pane", "input"],
                    type: "object"
                },
                Task: {
                    additionalProperties: false,
                    properties: {
                        input: { type: "string" },
                        line: { type: "integer" },
                        task: { type: "string" },
                        timeMs: { type: "integer" }
                    },
                    required: ["task", "input"],
                    type: "object"
                }
            },
            anyOf: [{ $ref: "#/$defs/Task" }, { $ref: "#/$defs/Pane" }]
        }
    };

    const canonical = adapter.toMcpTool(tmuxInput, "Send input");
    const model = adapter.toMcpTool(tmuxInput, "Send input", { modelFacing: true });
    const canonicalProperties = (canonical.inputSchema as { properties?: Record<string, unknown> }).properties;
    const modelProperties = (model.inputSchema as { properties?: Record<string, unknown> }).properties;

    assert.notEqual(canonicalProperties?.line, undefined);
    assert.notEqual(canonicalProperties?.timeMs, undefined);
    assert.deepEqual(Object.keys(modelProperties ?? {}).sort(), ["input", "pane", "task"]);
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

test("McpToolSchemaAdapter compacts model-facing prose and output schemas", () => {
    const adapter = new McpToolSchemaAdapter();
    const tool = adapter.toMcpTool({
        ...bashRun,
        inputSchema: {
            $defs: {
                Unused: { properties: { stale: { type: "string" } }, type: "object" },
                Used: { enum: ["safe"], type: "string" },
            },
            $schema: "https://json-schema.org/draft/2020-12/schema",
            additionalProperties: false,
            properties: {
                command: { description: "Shell command to execute.", type: "string" },
                cwd: { description: "A deliberately verbose working-directory description that should be replaced.", type: "string" },
                mode: { $ref: "#/$defs/Used" },
                purpose: { description: "A deliberately verbose provenance description.", maxLength: 160, type: "string" },
            },
            required: ["command"],
            title: "VerboseInputTitle",
            type: "object",
        },
        outputSchema: {
            properties: { stdout: { type: "string" } },
            required: ["stdout"],
            type: "object",
        },
    }, "Run shell", { modelFacing: true });

    const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties;
    assert.equal(properties?.command?.description, undefined);
    assert.equal(properties?.cwd?.description, "Working directory; ./ is workspace-relative, / absolute.");
    assert.equal(properties?.purpose?.description, "Intended outcome.");
    const input = tool.inputSchema as Record<string, unknown>;
    assert.equal(input.$schema, undefined);
    assert.equal(input.title, undefined);
    assert.deepEqual(Object.keys((input.$defs as Record<string, unknown>) ?? {}), ["Used"]);
    assert.deepEqual(tool.outputSchema, { type: "object" });
});
