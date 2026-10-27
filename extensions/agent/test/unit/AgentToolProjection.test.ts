import assert from "node:assert/strict";
import test from "node:test";
import { projectAgentModelToolResult } from "../../src/builtin/provider/AgentToolProjection.ts";

test("256-operation Agent edit projection preserves the middle failure and batch outcomes", () => {
    const operations = Array.from({ length: 256 }, (_, index) => ({
        action: "write", path: `src/feature-${index}-${"x".repeat(60)}.ts`,
        status: index < 127 ? "applied" : index === 127 ? "failed" : "not_executed",
        ...(index === 127 ? { error: { code: "file.writeFailed", message: "D-FAILURE-MUST-SURVIVE: Permission denied" } } : {}),
    }));
    const text = projectAgentModelToolResult("file_edit", { operations });
    assert.ok(text.length <= 12_000);
    assert.ok(text.includes(operations[127]!.path));
    assert.match(text, /file.writeFailed: D-FAILURE-MUST-SURVIVE: Permission denied/u);
    assert.match(text, /totalOperations=256 appliedOperations=127 failedOperations=1 notExecutedOperations=128/u);
    assert.equal(operations[127]!.status, "failed");
});

test("Agent edit summary keeps all-success batches successful", () => {
    const text = projectAgentModelToolResult("file_edit", { operations: [
        { action: "write", path: "a.ts", status: "applied", addedLines: 1 },
    ] });
    assert.match(text, /appliedOperations=1 failedOperations=0 notExecutedOperations=0/u);
    assert.match(text, /write a.ts applied \+1/u);
    assert.doesNotMatch(text, /error=/u);
});
