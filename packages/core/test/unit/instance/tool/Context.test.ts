import assert from "node:assert/strict";
import test from "node:test";

import { createToolCallScope } from "../../../../src/toolcall/Context.ts";

test("tool-call live event metadata excludes full input and bounds its summary", () => {
    const input = {
        command: "x".repeat(20_000),
        cwd: "/workspace",
    };
    const scope = createToolCallScope("bash_run", input, {
        ctxId: "ctx-large",
        requestId: "request-large",
        source: "mcp",
        workspace: "/projects/alpha",
    });

    assert.equal("input" in scope.eventContext, false);
    assert.equal(scope.input, input);
    assert.equal(scope.inputSummary.length <= 512, true);
    assert.equal(scope.eventContext.inputSummary, scope.inputSummary);
    assert.equal(scope.eventContext.workspace, "/projects/alpha");
});
