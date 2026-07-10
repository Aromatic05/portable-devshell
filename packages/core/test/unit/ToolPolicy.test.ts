import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes } from "@portable-devshell/shared";
import { ToolAllowlist, WorkerToolCatalog } from "@portable-devshell/core";

test("WorkerToolCatalog filters tools through allowlist and resets on clear", () => {
    const catalog = new WorkerToolCatalog(new ToolAllowlist(["bash_run"]));

    const tools = catalog.refresh([
        {
            access: "execute",
            description: "Run a shell command.",
            inputSchema: {
                properties: {
                    command: { type: "string" }
                },
                required: ["command"],
                type: "object"
            },
            name: "bash_run",
            outputSchema: { type: "object" }
        },
        {
            access: "read",
            description: "Should be filtered.",
            inputSchema: {},
            name: "internal_only",
            outputSchema: {}
        }
    ]);

    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "bash_run");

    catalog.clear();
    assert.deepEqual(catalog.listTools(), []);
});

test("WorkerToolCatalog rejects invalid tool schema from tools.list", () => {
    const catalog = new WorkerToolCatalog(new ToolAllowlist([]));

    assert.throws(
        () =>
            catalog.refresh([
                {
                    access: "execute",
                    description: "Missing tool name.",
                    inputSchema: {},
                    name: "",
                    outputSchema: {}
                }
            ]),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolSchemaUnavailable);
            return true;
        }
    );
});

test("WorkerToolCatalog rejects tool definitions without output schema or access", () => {
    const catalog = new WorkerToolCatalog(new ToolAllowlist([]));

    assert.throws(() => catalog.refresh([
        {
            description: "Incomplete tool.",
            inputSchema: {},
            name: "bash_run"
        } as never
    ]));
});
