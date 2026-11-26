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
        ["task_input", { task: { id: "task-1", status: "0" }, stdout: "done", stderr: "", termination: "exited", exitCode: 0 }],
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
    for (const toolName of ["bash_run", "task_input", "task_inspect", "task_manage", "file_edit"]) {
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

test("Agent model tool projection applies _meta.devshell.mcp.inputHints to matching properties", () => {
    const tools = projectAgentModelTools([
        {
            name: "task_input",
            description: "Send input or read task output",
            _meta: {
                devshell: {
                    mcp: {
                        inputHints: {
                            ctxId: "Current Context ID.",
                            input: "Raw UTF-8 text (use \\r for Enter, \\u0003 for Ctrl+C).",
                            cursor: "Opaque cursor from bash_run, task_manage(create), or task_input.",
                        },
                    },
                },
            },
            inputSchema: {
                type: "object",
                properties: {
                    ctxId: { type: "string", description: "Consumer only" },
                    task: { type: "string", description: "Original task description" },
                    input: { type: "string", description: "Stale input doc" },
                    cursor: { type: "string" },
                },
                required: ["ctxId", "task"],
            },
        },
        {
            name: "file_read",
            description: "Read files",
            _meta: {
                devshell: {
                    mcp: {
                        inputHints: {
                            selector: "Lines: N, N-M, N+count, or comma ranges; add :raw for exact ranges.",
                        },
                    },
                },
            },
            inputSchema: {
                type: "object",
                properties: {
                    files: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                path: { type: "string" },
                                selector: { type: "string", description: "Stale selector doc" },
                            },
                        },
                    },
                },
                required: ["files"],
            },
        },
    ]);

    const taskInputSchema = tools[0]?.inputSchema as {
        properties?: Record<string, { description?: string }>;
        required?: string[];
    };
    assert.equal(taskInputSchema.properties?.ctxId, undefined);
    assert.deepEqual(taskInputSchema.required, ["task"]);
    assert.equal(taskInputSchema.properties?.task?.description, "Original task description");
    assert.equal(
        taskInputSchema.properties?.input?.description,
        "Raw UTF-8 text (use \\r for Enter, \\u0003 for Ctrl+C).",
    );
    assert.equal(
        taskInputSchema.properties?.cursor?.description,
        "Opaque cursor from bash_run, task_manage(create), or task_input.",
    );

    const fileReadSchema = tools[1]?.inputSchema as {
        properties?: {
            files?: {
                items?: {
                    properties?: Record<string, { description?: string }>;
                };
            };
        };
    };
    assert.equal(
        fileReadSchema.properties?.files?.items?.properties?.selector?.description,
        "Lines: N, N-M, N+count, or comma ranges; add :raw for exact ranges.",
    );
});

test("Agent bash/task result projection preserves detached, waitMs, and untilExit handoff state", () => {
    const detachedResult = projectAgentModelToolResult("bash_run", {
        termination: "running",
        detached: true,
        waitMs: 120_000,
        untilExit: true,
        waitReason: "timeout",
        cursor: "cur-1",
        task: { id: "task-1", status: "running" },
        stdout: "building...",
        stderr: "",
    });
    assert.match(
        detachedResult,
        /^termination=running detached=true waitMs=120000 untilExit=true\b/mu,
    );
    assert.match(detachedResult, /waitReason=timeout/u);

    const normalResult = projectAgentModelToolResult("task_input", {
        termination: "exited",
        exitCode: 0,
        detached: false,
        untilExit: false,
        durationMs: 42,
        stdout: "done",
        stderr: "",
    });
    assert.match(normalResult, /^termination=exited exitCode=0 durationMs=42$/mu);
    assert.doesNotMatch(normalResult, /detached=/u);
    assert.doesNotMatch(normalResult, /untilExit=/u);
});
