import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes } from "@portable-devshell/shared";

import { WorkerToolCatalog } from "../../../dist/tools/catalog/WorkerToolCatalog.js";
import { ToolAllowlist } from "../../../dist/tools/policy/ToolAllowlist.js";

test("WorkerToolCatalog filters tools through allowlist and resets on clear", () => {
    const catalog = new WorkerToolCatalog(new ToolAllowlist(["bash_run"]));

    const tools = catalog.refresh([
        {
            description: "Run a shell command.",
            inputSchema: {
                properties: {
                    command: { type: "string" }
                },
                required: ["command"],
                type: "object"
            },
            name: "bash_run"
        },
        {
            description: "Should be filtered.",
            inputSchema: {},
            name: "internal_only"
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
                    description: "Missing tool name.",
                    inputSchema: {},
                    name: ""
                }
            ]),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.toolSchemaInvalid);
            return true;
        }
    );
});
