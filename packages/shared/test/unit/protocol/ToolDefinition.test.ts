import assert from "node:assert/strict";
import test from "node:test";

import { toolSchema } from "@portable-devshell/shared";

const validTool = {
    description: "Run a command",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: { command: { type: "string" } },
        required: ["command"],
        type: "object"
    },
    name: "bash_run",
    outputSchema: {
        properties: { exitCode: { type: "integer" } },
        type: "object"
    },
    requiredCapabilities: ["execute"]
};

test("tool schema accepts a valid tool definition", () => {
    assert.deepEqual(toolSchema.parse(validTool), validTool);
    assert.deepEqual(toolSchema.safeParse(validTool), {
        data: validTool,
        success: true
    });
});

test("tool schema rejects malformed fields and capability lists", () => {
    const cases: unknown[] = [
        null,
        { ...validTool, name: "" },
        { ...validTool, name: "bash" },
        { ...validTool, description: 1 },
        { ...validTool, group: "" },
        { ...validTool, group: "file" },
        { ...validTool, inputSchema: [] },
        { ...validTool, requiredCapabilities: "execute" },
        { ...validTool, requiredCapabilities: ["admin"] },
        { ...validTool, requiredCapabilities: ["read", "read"] }
    ];

    for (const value of cases) {
        assert.throws(() => toolSchema.parse(value));
    }
});

test("tool schema requires group to equal the namespace before the first underscore", () => {
    assert.equal(toolSchema.parse(validTool).group, "bash");
    assert.throws(
        () => toolSchema.parse({ ...validTool, name: "bash_run_detached" }),
        /namespace_operation/iu,
    );
    assert.throws(
        () => toolSchema.parse({ ...validTool, name: "bash_run-x" }),
        /namespace_operation/iu,
    );
    assert.throws(
        () => toolSchema.parse({ ...validTool, group: "shell", name: "bash_run" }),
        /tool\.group.*namespace bash/iu,
    );
});

test("tool schema safeParse returns the parsing error without throwing", () => {
    const result = toolSchema.safeParse({ ...validTool, requiredCapabilities: ["invalid"] });

    assert.equal(result.success, false);
});
