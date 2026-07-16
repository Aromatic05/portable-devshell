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

test("tool schema parses the complete frozen tool definition", () => {
    assert.deepEqual(toolSchema.parse(validTool), validTool);
    assert.deepEqual(toolSchema.safeParse(validTool), {
        data: validTool,
        success: true
    });
});

test("tool schema rejects malformed fields and capability lists", () => {
    const cases: Array<{ expected: RegExp; value: unknown }> = [
        { expected: /must be an object/u, value: null },
        { expected: /name must be a non-empty string/u, value: { ...validTool, name: "" } },
        { expected: /description must be a string/u, value: { ...validTool, description: 1 } },
        { expected: /group must be a non-empty string/u, value: { ...validTool, group: "" } },
        { expected: /schemas must be JSON objects/u, value: { ...validTool, inputSchema: [] } },
        { expected: /requiredCapabilities must be an array/u, value: { ...validTool, requiredCapabilities: "execute" } },
        {
            expected: /contains an invalid capability/u,
            value: { ...validTool, requiredCapabilities: ["admin"] }
        },
        {
            expected: /contains duplicate capability: read/u,
            value: { ...validTool, requiredCapabilities: ["read", "read"] }
        }
    ];

    for (const entry of cases) {
        assert.throws(() => toolSchema.parse(entry.value), entry.expected);
    }
});

test("tool schema safeParse returns the parsing error without throwing", () => {
    const result = toolSchema.safeParse({ ...validTool, requiredCapabilities: ["invalid"] });

    assert.equal(result.success, false);
    if (!result.success) {
        assert.match(result.error.message, /invalid capability/u);
    }
});
