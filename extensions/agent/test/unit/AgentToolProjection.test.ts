import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@portable-devshell/shared";
import { projectAgentModelToolResult, projectAgentModelTools } from "../../src/builtin/provider/AgentToolProjection.ts";

test("Agent model tools use the Worker tool description and field documentation", () => {
    const tools = projectAgentModelTools([{
        name: "file_edit",
        description: "Worker's canonical edit instructions",
        inputSchema: {
            type: "object",
            properties: { changes: { type: "string", description: "Worker's five operations and edit syntax" } },
            required: ["changes"],
        },
    }]);
    assert.equal(tools[0]?.description, "Worker's canonical edit instructions");
    const input = tools[0]?.inputSchema as { properties?: { changes?: { description?: string } } };
    assert.equal(input.properties?.changes?.description, "Worker's five operations and edit syntax");
});

test("Agent model tool results retain Comment advice and user instructions", () => {
    const comment = [
        "[file.partialRead] Continue with nextSelector.",
        "User requested a change of direction",
    ];
    const results: Array<[string, Record<string, JsonValue>]> = [
        ["file_read", { files: [{ path: "example.ts", view: "content", content: "1:hello", nextSelector: "2" }] }],
        ["bash_run", { stdout: "ok", stderr: "", exitCode: 0 }],
        ["file_edit", { operations: [{ action: "patch", path: "example.ts", status: "applied" }] }],
        ["tmux_read", { task: { id: "task-1", status: "0" }, output: ["done"] }],
    ];
    for (const [toolName, value] of results) {
        const text = projectAgentModelToolResult(toolName, { ...value, comment });
        assert.ok(text.startsWith(`comment:\n${comment.join("\n")}\n`), toolName);
        assert.equal(text.split(comment[1]).length - 1, 1, toolName);
        assert.ok(text.length <= 12_000, toolName);
    }
});

test("Agent tool result truncation reserves Comment ahead of long output", () => {
    const instruction = "User asked to stop the current approach";
    const text = projectAgentModelToolResult("bash_run", {
        comment: [instruction],
        exitCode: 0,
        stdout: "x".repeat(50_000),
        stderr: "",
    });
    assert.ok(text.startsWith(`comment:\n${instruction}\n`));
    assert.ok(text.length <= 12_000);
});

test("Agent success renderers do not swallow a structured tool error", () => {
    for (const toolName of ["bash_run", "tmux_read", "tmux_run", "file_edit"]) {
        const text = projectAgentModelToolResult(toolName, {
            error: { code: "file.unreadRange", message: "read coverage required", retryable: true },
            comment: ["[file.unreadRange] Read the missing source lines."],
        });
        assert.match(text, /file\.unreadRange/u, toolName);
        assert.match(text, /read coverage required/u, toolName);
        assert.match(text, /Read the missing source lines/u, toolName);
        assert.ok(text.startsWith("comment:\n"), toolName);
    }
});

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
