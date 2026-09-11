import assert from "node:assert/strict";
import test from "node:test";

import {
    prepareAgentModelToolInput,
    projectAgentModelToolResult,
    projectAgentModelTools
} from "../../src/builtin/provider/AgentToolProjection.ts";

test("Agent model projection filters capabilities and strips non-model input fields", () => {
    const bashSchema = {
        additionalProperties: false,
        properties: {
            command: { type: "string" },
            ctxId: { type: "string" },
            explanation: { type: "string" },
            instance: { type: "string" },
            purpose: { type: "string" }
        },
        required: ["command", "purpose", "instance"],
        type: "object"
    };
    const projected = projectAgentModelTools([
        { description: "Run bash", inputSchema: bashSchema, name: "bash_run" },
        {
            description: "Edit files",
            inputSchema: {
                properties: {
                    changes: { type: "string" },
                    resultDetail: { type: "string" }
                },
                required: ["changes", "resultDetail"],
                type: "object"
            },
            name: "file_edit"
        },
        {
            description: "Read tmux output",
            inputSchema: {
                properties: {
                    consumeOutput: { type: "boolean" },
                    task: { type: "string" }
                },
                type: "object"
            },
            name: "tmux_read"
        },
        { description: "Host-internal capability", inputSchema: { type: "object" }, name: "future_internal" }
    ]);

    assert.deepEqual(projected.map((tool) => tool.name), ["bash_run", "file_edit", "tmux_read"]);
    assert.match(projected[0]?.description ?? "", /tmux_run/u);
    assert.notEqual(projected[0]?.description, "Run bash");
    assert.deepEqual(
        (projected[0]?.inputSchema as { properties?: Record<string, unknown> }).properties,
        { command: { type: "string" } }
    );
    assert.deepEqual((projected[0]?.inputSchema as { required?: string[] }).required, ["command"]);
    assert.equal(
        (projected[1]?.inputSchema as { properties?: Record<string, unknown> }).properties?.resultDetail,
        undefined
    );
    assert.equal(
        (projected[2]?.inputSchema as { properties?: Record<string, unknown> }).properties?.consumeOutput,
        undefined
    );
    assert.notEqual(bashSchema.properties.purpose, undefined, "projection must not mutate the canonical Worker schema");
});

test("Agent model projection owns usage descriptions without mutating Worker schema descriptions", () => {
    const inputSchema = {
        properties: {
            command: { type: "string" },
            consumeOutput: { description: "Worker internal", type: ["boolean", "null"] },
            timeout: { description: "Worker neutral timeout", type: ["number", "null"] },
            wait: { description: "Worker neutral wait", type: ["string", "null"] }
        },
        required: ["command"],
        type: "object"
    };
    const [projected] = projectAgentModelTools([{
        description: "Worker neutral tmux contract",
        inputSchema,
        name: "tmux_run"
    }]);

    assert.match(projected?.description ?? "", /Prefer wait=block/u);
    assert.match(projected?.description ?? "", /tmux_read/u);
    const properties = (projected?.inputSchema as { properties?: Record<string, { description?: string }> }).properties;
    assert.match(properties?.wait?.description ?? "", /Prefer block/u);
    assert.match(properties?.timeout?.description ?? "", /critical-path wait/u);
    assert.equal(properties?.consumeOutput, undefined);
    assert.equal(inputSchema.properties.wait.description, "Worker neutral wait");
    assert.equal(inputSchema.properties.timeout.description, "Worker neutral timeout");
});

test("every Agent model tool has an Agent-owned description", () => {
    const names = [
        "bash_run",
        "file_edit",
        "file_glob",
        "file_grep",
        "file_read",
        "tmux_input",
        "tmux_inspect",
        "tmux_manage",
        "tmux_read",
        "tmux_run"
    ];
    const projected = projectAgentModelTools(names.map((name) => ({
        description: `Worker canonical ${name}`,
        inputSchema: { properties: {}, type: "object" },
        name
    })));

    assert.deepEqual(projected.map((tool) => tool.name), names);
    for (const tool of projected) {
        assert.notEqual(tool.description, `Worker canonical ${tool.name}`);
        assert.equal(tool.description.length > 40, true, tool.name);
    }
});

test("Agent model projection owns input preparation and bounded result projection", () => {
    const changes = "*** Begin Edit\n*** Write File: ./demo.txt\nhello\n*** End Edit";
    assert.deepEqual(
        prepareAgentModelToolInput("file_edit", { changes, resultDetail: "summary" }),
        { changes, resultDetail: "diff" }
    );

    const recoveryPath = "/.devshell/tool-results/11111111-1111-1111-1111-111111111111/stdout";
    const text = projectAgentModelToolResult("bash_run", {
        exitCode: 0,
        stderr: "",
        stdout: `head-${"x".repeat(100_000)}-tail`,
        stdoutArtifact: { handle: "private-handle" },
        stdoutPath: recoveryPath,
        termination: "exited"
    });
    assert.equal(text.length < 12_000, true);
    assert.match(text, /semantic preview clipped/u);
    assert.match(text, /head-/u);
    assert.match(text, /-tail/u);
    assert.equal(text.includes(recoveryPath), true);
    assert.doesNotMatch(text, /stdoutArtifact|private-handle/u);
});

test("Agent model result projection preserves file source and continuation semantics", () => {
    const read = projectAgentModelToolResult("file_read", {
        files: [
            {
                content: `1:head\n2:${"x".repeat(12_000)}\n3:tail`,
                language: "typescript",
                path: "./src/demo.ts",
                truncated: true,
                nextSelector: "4",
                view: "content"
            },
            {
                metadata: { exists: true, mode: 420, sizeBytes: 42, type: "file" },
                path: "./README.md",
                view: "metadata"
            }
        ]
    });
    assert.equal(read.length < 12_000, true);
    assert.match(read, /file=\.\/src\/demo\.ts view=content language=typescript/u);
    assert.match(read, /semantic preview clipped/u);
    assert.match(read, /nextSelector=4; continue with file_read on \.\/src\/demo\.ts/u);
    assert.match(read, /file=\.\/README\.md view=metadata/u);
    assert.match(read, /metadata=\{"exists":true,"mode":420,"sizeBytes":42,"type":"file"\}/u);

    const glob = projectAgentModelToolResult("file_glob", {
        entries: [
            { path: "./src", type: "directory" },
            { path: "./src/index.ts", type: "file" }
        ],
        nextCursor: "glob-next"
    });
    assert.match(glob, /^\.\/src\/\n\.\/src\/index\.ts/mu);
    assert.match(glob, /nextCursor=glob-next; continue with file_glob cursor only/u);

    const grep = projectAgentModelToolResult("file_grep", {
        files: [{
            content: `10:match\n11:${"y".repeat(12_000)}`,
            nextLine: 12,
            path: "./src/index.ts",
            truncated: true
        }],
        nextCursor: "grep-next"
    });
    assert.equal(grep.length < 12_000, true);
    assert.match(grep, /file=\.\/src\/index\.ts/u);
    assert.match(grep, /nextLine=12; continue file_grep against exact path \.\/src\/index\.ts/u);
    assert.match(grep, /nextCursor=grep-next; continue with file_grep cursor only/u);
});

test("Agent model result projection keeps tmux identities and transcript recovery", () => {
    const run = projectAgentModelToolResult("tmux_run", {
        detached: true,
        output: [`head-${"z".repeat(12_000)}-tail`],
        pane: { id: "pane-a", name: "task-a" },
        task: { id: "task-a", status: "running" }
    });
    assert.equal(run.length < 12_000, true);
    assert.match(run, /task=task-a status=running pane=pane-a paneName=task-a detached=true/u);
    assert.match(run, /semantic preview clipped/u);
    assert.match(run, /continue with tmux_read task=task-a/u);

    const inspect = projectAgentModelToolResult("tmux_inspect", {
        panes: [{
            cwd: "/repo",
            id: "pane-a",
            lines: [`top-${"q".repeat(12_000)}-bottom`],
            name: "main",
            size: { columns: 120, rows: 40 },
            status: "running"
        }]
    });
    assert.match(inspect, /pane=pane-a name=main status=running cwd=\/repo size=120x40/u);
    assert.match(inspect, /rerun tmux_inspect pane=pane-a with narrower start\/end/u);

    assert.match(projectAgentModelToolResult("tmux_manage", {
        panes: [{ id: "pane-a", name: "main", status: "running", task: { id: "task-a", status: "running" } }]
    }), /pane=pane-a name=main status=running task=task-a taskStatus=running/u);
    assert.equal(projectAgentModelToolResult("tmux_manage", { pane: { id: "pane-b", name: "shell" } }), "pane=pane-b name=shell");
    assert.equal(projectAgentModelToolResult("tmux_manage", { closedTaskId: "task-a" }), "closedTask=task-a");
});

test("Agent model file_edit projection preserves failures without echoing full diffs", () => {
    const result = projectAgentModelToolResult("file_edit", {
        operations: [{
            action: "patch",
            addedLines: 1,
            diff: "very large diff that should not be echoed",
            error: {
                code: "file.patchConflict",
                details: { candidateLines: [10, 20], hunk: 1 },
                message: "context changed",
                retryable: true
            },
            path: "./src/demo.ts",
            removedLines: 1,
            status: "failed"
        }]
    });
    assert.match(result, /patch \.\/src\/demo\.ts failed \+1 -1/u);
    assert.match(result, /error=file\.patchConflict: context changed: retryable/u);
    assert.match(result, /errorDetails=\{[\s\S]*"candidateLines"[\s\S]*\}/u);
    assert.doesNotMatch(result, /very large diff/u);
});

test("Agent model result hard ceiling remains a final backstop", () => {
    const result = projectAgentModelToolResult("tmux_manage", {
        panes: Array.from({ length: 1_000 }, (_, index) => ({
            id: `pane-${index}`,
            name: `terminal-${index}-${"x".repeat(20)}`,
            status: "running"
        }))
    });
    assert.equal(result.length, 12_000);
    assert.match(result, /tool result truncated: \d+ characters total/u);
    assert.match(result, /pane-0/u);
    assert.match(result, /pane-999/u);
});
