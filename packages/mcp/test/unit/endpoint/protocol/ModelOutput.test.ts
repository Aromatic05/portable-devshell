import assert from "node:assert/strict";
import test from "node:test";

import { McpNativeToolResult } from "../../../../src/protocol/call/Boundary.ts";
import {
    projectMcpModelOutput,
    validateMcpModelOutputBudget,
} from "../../../../src/protocol/call/ModelOutput.ts";
import type { JsonValue } from "@portable-devshell/shared";
import {
    applyConfigMcpPatch,
    normalizeConfigGlobalDraft,
    parseConfigMcpPatch,
    validateConfigSemantics,
} from "@portable-devshell/shared";

function data(value: JsonValue | McpNativeToolResult): Record<string, JsonValue> {
    return (value instanceof McpNativeToolResult
        ? value.structuredContent : value) as Record<string, JsonValue>;
}

function size(value: JsonValue | McpNativeToolResult): number {
    const structured = data(value);
    const content = value instanceof McpNativeToolResult ? value.content : [];
    return Buffer.byteLength(JSON.stringify(structured), "utf8") +
        content.reduce((total, entry) => total +
            (entry.type === "text" ? Buffer.byteLength(entry.text, "utf8") : 0), 0);
}

test("model projection keeps small native results and bypasses MCP App interactions", () => {
    const result = new McpNativeToolResult({
        content: [{ text: "ok", type: "text" }],
        isError: false,
        structuredContent: { ok: true },
        _meta: { "openai/outputTemplate": "ui://test/app" },
    });
    assert.equal(projectMcpModelOutput("file_read", result), result);
    assert.equal(projectMcpModelOutput("mcpapp_open", result), result);
});

test("bash model output stays bounded and retains recovery paths and execution status", () => {
    const original = {
        stdout: "BEGIN\n" + "中".repeat(7_000) + "\nEND",
        stderr: "WARNING\n" + "界".repeat(2_000),
        stdoutBytes: 21_010,
        stderrBytes: 6_008,
        stdoutPath: "/.devshell/tool-results/one/stdout",
        stderrPath: "/.devshell/tool-results/one/stderr",
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: 0,
    };
    const projected = projectMcpModelOutput("bash_run", original);
    const output = data(projected);
    assert.equal(size(projected) <= 4_000 * 3, true);
    assert.equal(output.stdoutPath, original.stdoutPath);
    assert.equal(output.stderrPath, original.stderrPath);
    assert.equal(output.exitCode, 0);
    assert.equal(output.stdoutTruncated, true);
    assert.equal(output.stderrTruncated, true);
    assert.equal((output.stdout as string).startsWith("BEGIN"), true);
    assert.equal((output.stdout as string).endsWith("END"), true);
    assert.equal((output.stdout as string).includes("�"), false);
    assert.equal(original.stdout.includes("\nEND"), true);
});

test("default 4000-token bash budget preserves ~11 KB of complete source output", () => {
    for (const stdoutSize of [10_720, 10_992]) {
        const rows = 160;
        const perRow = Math.floor(stdoutSize / rows);
        const leftover = stdoutSize - rows * perRow;
        const stdout = Array.from({ length: rows }, (_, index) => {
            const prefix = "line_" + String(index).padStart(4, "0") + "_";
            const fill = perRow - prefix.length - 1 +
                (index === rows - 1 ? leftover : 0);
            return prefix + "x".repeat(fill) + "\n";
        }).join("");
        const result = {
            exitCode: 0,
            stdout,
            stderr: "",
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
            termination: "exited",
            durationMs: 5,
        };
        const projected = projectMcpModelOutput("bash_run", result);
        assert.equal(size(projected) <= 4_000 * 3, true);
        assert.equal(data(projected).stdout === stdout, true);
        assert.equal(data(projected).stdoutTruncated, false);
    }
});

test("bash projection with smaller custom budget trims the same source output", () => {
    const original = {
        stdout: "source line\n".repeat(900),
        stderr: "",
        stdoutBytes: 10_800,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: 0,
    };
    const projected = projectMcpModelOutput("bash_run", original, {
        byTool: { bash_run: 1_000 },
    });
    assert.equal(size(projected) <= 1_000 * 3, true);
    assert.equal(data(projected).stdoutTruncated, true);
    assert.notEqual(data(projected).stdout, original.stdout);
});

test("native presentation text also consumes the 4000-token bash budget", () => {
    const stdout = Array.from({ length: 160 }, (_, index) =>
        "line_" + String(index).padStart(4, "0") + "_" + "x".repeat(56) + "\n")
        .join("");
    const original = {
        stdout,
        stderr: "",
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: 0,
    };
    assert.equal(size(original) < 4_000 * 3, true);
    const native = new McpNativeToolResult({
        structuredContent: original,
        content: [{ text: "presentation ".repeat(200), type: "text" }],
    });
    const projected = projectMcpModelOutput("bash_run", native);
    assert.equal(size(projected) <= 4_000 * 3, true);
    assert.equal(data(projected).stdoutTruncated, true);
    assert.notEqual(data(projected).stdout, stdout);
});

test("file_read preserves file identity and resumes its original paged selector", () => {
    const content = Array.from({ length: 200 }, (_, i) =>
        `${i + 1}:${"x".repeat(140)}`).join("\n");
    const value = { files: [{ path: "/project/src/a.ts", view: "content", content,
        nextSelector: "201" }] };
    const projected = projectMcpModelOutput("file_read", value);
    const file = data(projected).files as Array<Record<string, JsonValue>>;
    assert.equal(size(projected) <= 6_000 * 3, true);
    assert.equal(file[0]?.path, "/project/src/a.ts");
    assert.equal(file[0]?.truncated, true);
    assert.match(file[0]?.nextSelector as string, /^\d+-200:raw;next=201$/u);
    assert.equal((file[0]?.content as string).startsWith("1:"), true);
});

test("file_read outline previews never fabricate an invalid content selector", () => {
    const original = { files: [{
        path: "src/engine.ts", view: "outline", parseStatus: "complete",
        content: "export function example()\n".repeat(2_000),
    }] };
    const projected = projectMcpModelOutput("file_read", original);
    const file = (data(projected).files as Array<Record<string, JsonValue>>)[0]!;
    assert.equal(size(projected) <= 6_000 * 3, true);
    assert.equal(file.view, "outline");
    assert.equal(file.truncated, true);
    assert.equal(file.nextSelector, undefined);
    assert.match(file.content as string, /^export function/u);
});

test("file_grep keeps exact-file continuation and individual hit identities", () => {
    const content = Array.from({ length: 180 }, (_, i) =>
        `*${i + 1}:${"a".repeat(95)}`).join("\n");
    const projected = projectMcpModelOutput("file_grep", {
        files: [{ path: "src/engine.ts", content, nextLine: 181 }],
        nextCursor: "cursor-123",
    });
    const output = data(projected);
    const file = (output.files as Array<Record<string, JsonValue>>)[0]!;
    assert.equal(size(projected) <= 4_000 * 3, true);
    assert.equal(file.path, "src/engine.ts");
    assert.equal(file.truncated, true);
    assert.equal(typeof file.nextLine, "number");
    assert.equal((file.nextLine as number) <= 180, true);
    assert.equal(output.nextCursor, "cursor-123");
});

test("file_edit explicitly accounts for omitted applied operations", () => {
    const operations = Array.from({ length: 100 }, (_, i) => ({
        action: "patch", path: `src/example-${i}.ts`, status: "applied",
        addedLines: 1, removedLines: 0, diff: "x".repeat(1_000),
    }));
    const projected = projectMcpModelOutput("file_edit", { operations });
    const output = data(projected);
    assert.equal(size(projected) <= 2_000 * 3, true);
    assert.equal((output.omittedOperations as number) > 0, true);
    const shown = output.operations as Array<Record<string, JsonValue>>;
    assert.equal(shown.length + (output.omittedOperations as number), 100);
    assert.equal(shown.every((operation) => operation.status === "applied"), true);
    assert.equal(shown.every((operation) => operation.diff === undefined), true);
});

test("cursor-consuming results are never silently replaced with a preview", () => {
    const tmux = { task: { id: "task-1", status: "running" },
        output: ["line".repeat(3_000)] };
    const glob = { entries: Array.from({ length: 200 }, (_, i) => ({
        path: `path/${i}`, type: "file",
    })), nextCursor: "after-200" };
    assert.equal(projectMcpModelOutput("tmux_read", tmux), tmux);
    assert.equal(projectMcpModelOutput("file_glob", glob), glob);
});

test("model budgets allow caller-selected sizes without tool-specific minimums", () => {
    assert.doesNotThrow(() => validateMcpModelOutputBudget({
        maxTokens: 3_000,
        byTool: { tmux_read: 256, file_glob: 512 },
    }));
    assert.doesNotThrow(() => validateMcpModelOutputBudget({
        maxTokens: 40_000,
        byTool: { file_read: 30_000 },
    }));
    assert.throws(() => validateMcpModelOutputBudget({ maxTokens: 0 }));
    assert.throws(() => validateMcpModelOutputBudget({ byTool: { bash_run: -1 } }));
    assert.throws(() => validateMcpModelOutputBudget({ defaultTokens: 1.5 }));
});

test("explicit defaultTokens overrides per-tool library output presets", () => {
    const original = { stdout: "line".repeat(2_000), stderr: "", exitCode: 0 };
    const projected = projectMcpModelOutput("bash_run", original, { defaultTokens: 128 });
    assert.ok(size(projected) <= 128 * 3);
    assert.notDeepEqual(projected, original);
});

test("oversized read metadata does not turn a successful ToolCall into an error", () => {
    const original = { files: Array.from({ length: 40 }, (_, i) => ({
        path: `large-file-${i}`, content: "x".repeat(1_000), view: "content",
    })) };
    assert.equal(projectMcpModelOutput("file_read", original, { maxTokens: 1 }), original);
});

test("Control MCP modelOutput survives draft normalization and update patches", () => {
    const base = normalizeConfigGlobalDraft({});
    const parsed = parseConfigMcpPatch({
        modelOutput: { defaultTokens: 8_000, maxTokens: 12_000,
            byTool: { bash_run: 6_000, file_read: 10_000 } },
    });
    const next = normalizeConfigGlobalDraft({
        mcp: applyConfigMcpPatch(base.mcp, parsed),
    });
    assert.equal(next.mcp.modelOutput?.byTool?.bash_run, 6_000);
    assert.equal(next.mcp.modelOutput?.defaultTokens, 8_000);
    assert.doesNotThrow(() => validateConfigSemantics({ ...next, instances: [] }));
    assert.doesNotThrow(() => validateConfigSemantics({
        ...next,
        instances: [],
        mcp: { ...next.mcp, modelOutput: { byTool: { tmux_read: 2_000 } } },
    }));
    const cleared = normalizeConfigGlobalDraft({
        mcp: applyConfigMcpPatch(next.mcp, parseConfigMcpPatch({ modelOutput: null })),
    });
    assert.equal(cleared.mcp.modelOutput, undefined);
});
