import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@portable-devshell/shared";
import { InstanceToolCatalog } from "../../../../src/instance/model/Tools.ts";

const bashRun = tool("bash_run");
const fileRead = tool("file_read");
const fileWrite = tool("file_write");
const todoRead = tool("todo_read");

test("catalog merges registrations and tracks replacements", () => {
    const catalog = new InstanceToolCatalog();
    const worker = catalog.register([bashRun]);
    const host = catalog.register([fileWrite]);

    assert.deepEqual(
        catalog.list().map((definition) => definition.name),
        ["bash_run", "file_write"],
    );

    worker.replace([fileRead]);
    assert.deepEqual(
        catalog.list().map((definition) => definition.name),
        ["file_read", "file_write"],
    );

    host.dispose();
    assert.deepEqual(
        catalog.list().map((definition) => definition.name),
        ["file_read"],
    );
});

test("catalog rejects duplicate tool names across registrations atomically", () => {
    const catalog = new InstanceToolCatalog();
    const first = catalog.register([todoRead]);
    const second = catalog.register([fileRead]);
    assert.throws(() => catalog.register([todoRead]), /more than once/iu);

    first.replace([bashRun]);
    assert.throws(() => second.replace([bashRun]), /more than once/iu);
    assert.throws(() => catalog.register([bashRun]), /more than once/iu);
    assert.deepEqual(
        catalog.list().map((definition) => definition.name),
        ["bash_run", "file_read"],
    );
});

test("catalog rejects replacement after dispose", () => {
    const catalog = new InstanceToolCatalog();
    const registration = catalog.register([bashRun]);
    registration.dispose();
    registration.dispose();
    assert.throws(() => registration.replace([fileRead]), /disposed/iu);
    assert.deepEqual(catalog.list(), []);
});

test("catalog validates namespace groups", () => {
    const catalog = new InstanceToolCatalog();
    assert.throws(
        () => catalog.register([{ ...bashRun, group: "file" }]),
        /namespace/iu,
    );
    assert.deepEqual(catalog.list(), []);
});

function tool(
    name: string,
    requiredCapabilities: ToolDefinition["requiredCapabilities"] = [],
): ToolDefinition {
    return {
        description: name,
        group: name.slice(0, name.indexOf("_")),
        inputSchema: { type: "object" },
        name,
        outputSchema: { type: "object" },
        requiredCapabilities,
    };
}
