import assert from "node:assert/strict";
import test from "node:test";

import type { Component } from "@earendil-works/pi-tui";

import {
    parseDevshellAgentTarget,
    prepareToolInput,
    resolveToolSessionOpenInput
} from "../../src/index.ts";
import {
    formatPiToolCall,
    formatPiToolResult,
    parseEditChangeSet,
    renderPiToolCall,
    renderPiToolResult,
    renderWorkerUnifiedDiff,
    type PiThemeLike,
    type PiToolRenderContextLike
} from "../../src/renderer.ts";

const identityTheme: PiThemeLike = {
    bg: (_role, text) => text,
    bold: (text) => text,
    fg: (_role, text) => text,
    inverse: (text) => `[${text}]`
};

function context(args: unknown): PiToolRenderContextLike {
    return {
        args,
        argsComplete: true,
        cwd: "/repo",
        executionStarted: false,
        expanded: false,
        invalidate() {},
        isError: false,
        isPartial: false,
        showImages: false,
        state: {},
        toolCallId: "call-1"
    };
}

function visibleLines(component: Component): string[] {
    return component.render(120)
        .map((line) => line.slice(1).trimEnd())
        .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1));
}

test("Pi devshell target parser preserves remote workspace syntax", () => {
    assert.deepEqual(
        parseDevshellAgentTarget("worker-a:/srv/project"),
        { instance: "worker-a", workspace: "/srv/project" }
    );
    assert.deepEqual(
        parseDevshellAgentTarget("windows-worker:C:\\repo"),
        { instance: "windows-worker", workspace: "C:\\repo" }
    );
});

test("Pi devshell target parser rejects ambiguous bindings", () => {
    for (const value of ["", " worker:/repo", "worker", ":/repo", "bad name:/repo", "worker:"]) {
        assert.throws(() => parseDevshellAgentTarget(value));
    }
});

test("Pi devshell extension leaves unique instance selection to Control", () => {
    assert.deepEqual(
        resolveToolSessionOpenInput({ cwd: "/repo", environment: {} }),
        { workspace: "/repo" }
    );
    assert.deepEqual(
        resolveToolSessionOpenInput({ cwd: "/ignored", environment: {}, target: "worker-a:/srv/project" }),
        { instance: "worker-a", workspace: "/srv/project" }
    );
});

test("Pi devshell renderer formats common calls without JSON fallback", () => {
    assert.equal(
        formatPiToolCall("file_search", { pattern: "renderCall", paths: ["./src", "./test"] }),
        "file_search /renderCall/ in ./src, ./test"
    );
    assert.equal(
        formatPiToolCall("bash_run", { command: "pnpm test", cwd: "./packages/pi-extension" }),
        "bash_run $ pnpm test in ./packages/pi-extension"
    );
});

test("Pi devshell renderer turns file search results into readable sections", () => {
    const rendered = formatPiToolResult("file_search", {
        content: [],
        details: {
            files: [
                { path: "src/a.ts", content: "1:alpha\n2:beta" },
                { path: "src/b.ts", content: "7:gamma" }
            ]
        }
    }, false);
    assert.equal(rendered, [
        "src/a.ts",
        "  1:alpha",
        "  2:beta",
        "src/b.ts",
        "  7:gamma"
    ].join("\n"));
    assert.equal(rendered.includes("\"files\""), false);
});

test("Pi devshell file edit always requests diff details without exposing them to the model", () => {
    const changes = [
        "*** Begin Edit",
        "*** Patch File: ./a.txt",
        "@@",
        "-old",
        "+new",
        "*** End Edit"
    ].join("\n");
    assert.deepEqual(prepareToolInput("file_edit", { changes }), { changes, resultDetail: "diff" });
    assert.deepEqual(prepareToolInput("file_edit", { changes, resultDetail: "summary" }), { changes, resultDetail: "diff" });
});

test("Pi devshell parses the Worker edit grammar only as adapter input", () => {
    const operations = parseEditChangeSet([
        "*** Begin Edit",
        "*** Write File: ./new.txt",
        "hello",
        "*** Patch File: ./old.txt",
        "@@",
        "-old",
        "+new",
        "*** Move File: ./from.txt",
        "*** To: ./to.txt",
        "*** End Edit"
    ].join("\n"));
    assert.deepEqual(operations, [
        { body: "hello", kind: "write", path: "./new.txt" },
        { body: "@@\n-old\n+new", kind: "patch", path: "./old.txt" },
        { body: "", kind: "move", path: "./to.txt", source: "./from.txt" }
    ]);
});

test("Pi devshell Write File renders like native Pi write and has no success result block", () => {
    const args = {
        changes: [
            "*** Begin Edit",
            "*** Write File: ./tool-demo3.txt",
            "alpha",
            "",
            "beta",
            "*** End Edit"
        ].join("\n")
    };
    const callContext = context(args);
    const call = renderPiToolCall("file_edit", args, identityTheme, callContext);
    assert.deepEqual(visibleLines(call), [
        "write ./tool-demo3.txt",
        "",
        "alpha",
        "",
        "beta"
    ]);

    const result = renderPiToolResult("file_edit", {
        content: [{ type: "text", text: "write ./tool-demo3.txt applied +3" }],
        details: {
            operations: [{
                action: "write",
                path: "./tool-demo3.txt",
                status: "applied",
                diff: "--- original\n+++ modified\n@@ -0,0 +1,3 @@\n+alpha\n+\n+beta\n"
            }]
        }
    }, { expanded: false, isPartial: false }, identityTheme, { ...callContext, lastComponent: undefined });

    assert.deepEqual(result.render(120), []);
    const after = visibleLines(call);
    assert.deepEqual(after, ["write ./tool-demo3.txt", "", "alpha", "", "beta"]);
    assert.equal(after.join("\n").includes("***"), false);
    assert.equal(after.join("\n").includes("--- original"), false);
});

test("Pi devshell Patch File updates the call card with native Pi numbered diff", () => {
    const args = {
        changes: [
            "*** Begin Edit",
            "*** Patch File: ./a.txt",
            "@@",
            "-old value",
            "+new value",
            "*** End Edit"
        ].join("\n")
    };
    const callContext = context(args);
    const call = renderPiToolCall("file_edit", args, identityTheme, callContext);
    assert.deepEqual(visibleLines(call), ["edit ./a.txt"]);

    const resultSlot = renderPiToolResult("file_edit", {
        content: [{ type: "text", text: "patch ./a.txt applied +1 -1" }],
        details: {
            operations: [{
                action: "patch",
                path: "./a.txt",
                status: "applied",
                diff: "--- original\n+++ modified\n@@ -10,3 +10,3 @@\n keep\n-old value\n+new value\n tail\n"
            }]
        }
    }, { expanded: false, isPartial: false }, identityTheme, { ...callContext, lastComponent: undefined });

    assert.deepEqual(resultSlot.render(120), []);
    assert.deepEqual(visibleLines(call), [
        "edit ./a.txt",
        "",
        " 10 keep",
        "-11 [old] value",
        "+11 [new] value",
        " 12 tail"
    ]);
    const rendered = visibleLines(call).join("\n");
    for (const marker of ["***", "--- original", "+++ modified", "@@"]) assert.equal(rendered.includes(marker), false);
});

test("Pi devshell Worker unified diff adapter matches Pi numbered diff semantics", () => {
    assert.equal(
        renderWorkerUnifiedDiff(
            "--- original\n+++ modified\n@@ -3,2 +3,2 @@\n-old thing\n+new thing\n tail\n",
            identityTheme
        ),
        ["-3 [old] thing", "+3 [new] thing", " 4 tail"].join("\n")
    );
});
