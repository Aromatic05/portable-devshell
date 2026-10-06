import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "@portable-devshell/shared";
import { createToolCallRegistry } from "../../../src/toolcall/index.ts";

const environInfo = tool("environ_info");
const bashRun = tool("bash_run", ["execute"]);
const fileRead = tool("file_read", ["read"]);
const todoRead = tool("todo_read");

test("ToolCallRegistry overlays global definitions onto each instance", () => {
    const registry = createToolCallRegistry();
    const control = registry.registerAll([environInfo]);
    const worker = registry.register("local", [bashRun]);

    assert.deepEqual(
        registry.list("local").map((entry) => entry.definition.name),
        ["environ_info", "bash_run"],
    );
    assert.deepEqual(
        registry.list("remote").map((entry) => entry.definition.name),
        ["environ_info"],
    );

    worker.replace([fileRead]);
    assert.deepEqual(
        registry.list("local").map((entry) => entry.definition.name),
        ["environ_info", "file_read"],
    );

    control.dispose();
    assert.deepEqual(
        registry.list("local").map((entry) => entry.definition.name),
        ["file_read"],
    );
});

test("ToolCallRegistry rejects overlapping duplicate names atomically", () => {
    const registry = createToolCallRegistry();
    registry.registerAll([todoRead]);
    assert.throws(
        () => registry.register("local", [todoRead]),
        /more than once/iu,
    );

    const local = registry.register("local", [bashRun]);
    registry.register("remote", [bashRun]);
    assert.throws(() => local.replace([todoRead]), /more than once/iu);
    assert.equal(
        registry.get("local", "bash_run")?.definition.name,
        "bash_run",
    );
});

test("ToolCallRegistry validates namespace groups", () => {
    const registry = createToolCallRegistry();
    assert.throws(
        () => registry.register("local", [{ ...bashRun, group: "file" }]),
        /namespace/iu,
    );
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
