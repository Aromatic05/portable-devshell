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

test("Agent complete process result omits internal metadata and empty streams", () => {
    const result = {
        termination: "exited", exitCode: 0, durationMs: 12, stdout: "hello\n", stderr: "",
        stdoutBytes: 6, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
        task: { id: "task-1", status: "0", pty: false }, cursor: "tc3_done",
        stdoutPath: "/.devshell/tool-results/hidden/stdout", stdoutArtifact: { handle: "hidden" },
        waitReason: "terminal", waitMs: 10000,
    };
    const snapshot = structuredClone(result);
    for (const name of ["bash_run", "task_input"]) {
        assert.equal(projectAgentModelToolResult(name, result), "exitCode=0 durationMs=12\nstdout:\nhello\n");
    }
    assert.deepEqual(result, snapshot);
});

test("Agent bash/task projection preserves handoff without echoing wait parameters", () => {
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
        /^detached=true$/mu,
    );
    assert.match(detachedResult, /^task=task-1$/mu);
    assert.match(detachedResult, /^cursor="cur-1"$/mu);
    assert.doesNotMatch(detachedResult, /termination=|waitReason=|waitMs=|untilExit=/u);

    const normalResult = projectAgentModelToolResult("task_input", {
        termination: "exited",
        exitCode: 0,
        detached: false,
        untilExit: false,
        durationMs: 42,
        stdout: "done",
        stderr: "",
    });
    assert.match(normalResult, /^exitCode=0 durationMs=42$/mu);
    assert.doesNotMatch(normalResult, /detached=/u);
    assert.doesNotMatch(normalResult, /untilExit=/u);
});

test("Agent clipped task_input output without an artifact directs read-only polling, not input replay", () => {
    const comment = `The task is still running.\n${"Review note. ".repeat(300)}`;
    const result = {
        termination: "running",
        task: { id: "process-1", status: "running", pty: true },
        cursor: "tc2_cHJvY2Vzcy0xOjE6MTAwMDA6MA",
        waitReason: "output",
        stdout: "x".repeat(10_000),
        stdoutBytes: 10_000,
        stdoutTruncated: false,
        stderr: "",
        stderrBytes: 0,
        stderrTruncated: false,
        artifactWarnings: ["stdout artifact could not be persisted: disk full"],
        comment: [comment],
    };

    for (const name of ["task_input", "devshell_task_input"]) {
        const text = projectAgentModelToolResult(name, result);
        assert.doesNotMatch(text, /rerun with narrower output/u, name);
        assert.ok(text.startsWith(`comment:\n${comment}\n`), name);
        assert.match(text, /\[tool result truncated:/u, name);
        assert.match(text, /^stdoutProjectionClipped=true$/mu, name);
        assert.match(text, /Do not rerun the command or resend input/u, name);
        assert.match(text, /Observe the existing task with its returned ID and cursor; omit input/u, name);
        assert.ok(text.includes("task=process-1"), name);
        assert.ok(text.includes(`cursor=${JSON.stringify(result.cursor)}`), name);
        assert.doesNotMatch(text, /^waitReason=/mu, name);
        assert.match(text, /^warning=stdout artifact could not be persisted: disk full$/mu, name);
        assert.ok(text.length <= 12_000, name);
    }
});

test("Agent guides observation when worker truncation leaves no inline output or recovery path", () => {
    const text = projectAgentModelToolResult("task_input", {
        termination: "running",
        task: { id: "process-1", status: "running", pty: true },
        cursor: "tc2_cHJvY2Vzcy0xOjE6MTAwMDA6MA",
        stdout: "",
        stdoutTruncated: true,
        stderr: "",
        stderrTruncated: false,
        artifactWarnings: ["stdout artifact unavailable: Process Host capture limit reached"],
    });

    assert.match(text, /^stdoutTruncated=true$/mu);
    assert.match(text, /Do not rerun the command or resend input/u);
    assert.match(text, /Observe the existing task with its returned ID and cursor; omit input/u);
    assert.doesNotMatch(text, /stderrTruncated=true/u);
});

test("Agent keeps artifact recovery available alongside an unrecoverable clipped stream", () => {
    const text = projectAgentModelToolResult("devshell_bash_run", {
        termination: "running",
        task: { id: "process-1", status: "running", pty: false },
        cursor: "tc2_cHJvY2Vzcy0xOjE6NTAwMDo1MDAw",
        stdout: "x".repeat(5_000),
        stdoutPath: "/.devshell/tool-results/retained/stdout",
        stderr: "y".repeat(5_000),
        artifactWarnings: ["stderr artifact could not be persisted: disk full"],
    });

    assert.match(text, /^stdoutRecovery=\/\.devshell\/tool-results\/retained\/stdout$/mu);
    assert.match(text, /^stderrProjectionClipped=true$/mu);
    assert.doesNotMatch(text, /stdoutProjectionClipped=true|rerun with narrower output/u);
    assert.match(text, /Do not rerun the command or resend input/u);
    assert.match(text, /Observe the existing task with its returned ID and cursor; omit input/u);
});


test("Agent exposes uncertain durable Wait registration without suggesting replay", () => {
    const text = projectAgentModelToolResult("bash_run", {
        termination: "running",
        task: { id: "task-started", status: "running" },
        cursor: "tc3_cursor",
        waitError: {
            code: "wait.registrationFailed",
            message: "Durable Wait registration was not confirmed. Continue with task_input using the returned task ID and cursor; do not repeat the original call.",
        },
    });
    assert.match(text, /^waitError=\{"code":"wait.registrationFailed","message":"Durable Wait registration was not confirmed\. Continue with task_input using the returned task ID and cursor; do not repeat the original call\."\}$/mu);
    assert.match(text, /Continue with task_input/u);
    assert.doesNotMatch(text, /rerun the original call/u);
});


test("model projection preserves successful and failed creation handles when comments exhaust the budget", () => {
    const taskId = "process-00000000-0000-4000-8000-000000000001";
    const comment = ["user instruction ".repeat(20_000)];
    assert.match(projectAgentModelToolResult("bash_run", {
        task: { id: taskId }, termination: "running", comment,
    }), new RegExp(`^task=${taskId}\\n`, "u"));
    assert.match(projectAgentModelToolResult("task_manage", {
        comment,
        error: { code: "process.hostFailed", message: "read failed", retryable: false,
            details: { taskId, taskStart: "confirmed" } },
    }), new RegExp(`^taskId=${taskId} taskStart=confirmed.*do not repeat the creation call`, "u"));
});

test("task observation keeps its cursor and terminal outcome when comments consume the result budget", () => {
    const taskId = "process-00000000-0000-4000-8000-000000000001";
    const cursor = "tc3_resume";
    const comment = ["x".repeat(13_000)];
    const text = projectAgentModelToolResult("task_input", {
        task: { id: taskId, status: "exited" }, cursor, termination: "exited",
        exitCode: 0, waitReason: "terminal", stdoutPath: "/.devshell/tool-results/example/stdout", comment,
    });
    assert.match(text, /^task=process-/u);
    assert.ok(text.includes('cursor="tc3_resume"'));
    assert.doesNotMatch(text, /termination=exited/u);
    assert.ok(text.includes("exitCode=0"));
    assert.ok(text.includes("stdoutRecovery=/.devshell/tool-results/example/stdout"));
    const cancelled = projectAgentModelToolResult("task_input", {
        error: { code: "core.toolCallCancelled", message: "cancelled", retryable: false,
            details: { taskId, cursor } }, comment,
    });
    assert.match(cancelled, /^taskId=process-/u);
    assert.ok(cancelled.includes('cursor="tc3_resume"'));
    assert.ok(cancelled.includes("omit input"));
});
