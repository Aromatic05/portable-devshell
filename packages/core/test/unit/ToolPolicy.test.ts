import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes } from "@portable-devshell/shared";
import { WorkerToolCatalog } from "@portable-devshell/core/testing";

test("WorkerToolCatalog preserves the complete worker catalog and resets on clear", () => {
    const catalog = new WorkerToolCatalog();

    const tools = catalog.refresh([
        {
            requiredCapabilities: ["execute"],
            description: "Run a shell command.",
            group: "bash",
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
            requiredCapabilities: ["read"],
            description: "Read internal data.",
            group: "internal",
            inputSchema: {},
            name: "internal_only",
            outputSchema: {}
        }
    ]);

    assert.deepEqual(tools.map((tool) => tool.name), ["bash_run", "internal_only"]);

    catalog.clear();
    assert.deepEqual(catalog.listTools(), []);
});

test("WorkerToolCatalog rejects invalid tool schema from tools.list", () => {
    const catalog = new WorkerToolCatalog();

    assert.throws(
        () =>
            catalog.refresh([
                {
                    requiredCapabilities: ["execute"],
                    description: "Missing tool name.",
                    group: "bash",
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

test("WorkerToolCatalog identifies an incompatible Worker catalog", () => {
    const catalog = new WorkerToolCatalog();

    assert.throws(
        () => catalog.refresh([
            {
                requiredCapabilities: ["execute"],
                description: "Incomplete tool.",
                group: "bash",
                name: "bash_run"
            } as never
        ]),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, errorCodes.coreToolSchemaUnavailable);
            assert.match((error as { message?: string }).message ?? "", /Upgrade and restart the Worker/u);
            assert.equal((error as { details?: { reason?: string } }).details?.reason, "tool schemas must be JSON objects");
            return true;
        }
    );
});


test("WorkerToolCatalog accepts empty and multiple required capability lists", () => {
    const catalog = new WorkerToolCatalog();
    const tools = catalog.refresh([
        {
            description: "No capability required.",
            group: "todo",
            inputSchema: {},
            name: "todo_read",
            outputSchema: {},
            requiredCapabilities: []
        },
        {
            description: "Requires read and write.",
            group: "file",
            inputSchema: {},
            name: "file_sync",
            outputSchema: {},
            requiredCapabilities: ["read", "write"]
        }
    ]);

    assert.deepEqual(tools.map((tool) => tool.requiredCapabilities), [[], ["read", "write"]]);
});

test("WorkerToolCatalog rejects legacy access and duplicate required capabilities", () => {
    const catalog = new WorkerToolCatalog();

    assert.throws(() => catalog.refresh([{
        access: "read",
        description: "Legacy tool.",
        group: "file",
        inputSchema: {},
        name: "file_read",
        outputSchema: {}
    } as never]));

    assert.throws(() => catalog.refresh([{
        description: "Invalid tool.",
        group: "file",
        inputSchema: {},
        name: "file_read",
        outputSchema: {},
        requiredCapabilities: ["read", "read"]
    } as never]));
});
