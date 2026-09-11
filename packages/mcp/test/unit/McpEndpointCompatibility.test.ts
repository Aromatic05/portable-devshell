import assert from "node:assert/strict";
import test from "node:test";

import {
    adaptMcpLegacyFileToolInput,
    adaptMcpLegacyFileToolResult,
    adaptMcpLegacyTmuxToolInput,
    resolveMcpLegacyTool
} from "../../src/endpoint/McpEndpointCompatibility.ts";

test("legacy MCP compatibility aliases only the semantic superset", () => {
    assert.deepEqual(resolveMcpLegacyTool("ask_question"), {
        kind: "alias",
        replacement: "workspace_ask",
    });
    for (const [name, replacement] of [
        ["workspace_question_answer", "workspace_answer"],
        ["workspace_wait_interrupt", "workspace_interrupt"],
        ["workspace_task_control", "workspace_task"],
        ["workspace_goal_pause", "workspace_pause"],
        ["workspace_goal_resume", "workspace_resume"],
        ["workspace_goal_stop", "workspace_stop"],
        ["workspace_approval_decide", "workspace_approval"],
    ] as const) {
        assert.deepEqual(resolveMcpLegacyTool(name), {
            kind: "alias",
            replacement,
        }, name);
    }
});

test("v0.6.15 Workspace app protocol remains a hidden wire compatibility surface", () => {
    for (const [name, replacement] of [
        ["workspace_wait_recover", "workspace_recover"],
        ["workspace_goal_continue", "workspace_reentry"],
        ["workspace_reentry_control", "workspace_reentry"],
    ] as const) {
        assert.deepEqual(resolveMcpLegacyTool(name), {
            kind: "workspace-app-v0615",
            replacement,
        }, name);
    }
});

test("v0.7 file tool names remain hidden stale-schema aliases through v0.7.3", () => {
    for (const [name, replacement] of [
        ["file_find", "file_glob"],
        ["file_info", "file_read"],
        ["file_search", "file_grep"],
    ] as const) {
        assert.deepEqual(resolveMcpLegacyTool(name), {
            kind: "file-v07-alias",
            removeIn: "0.7.4",
            replacement,
        }, name);
    }
});

test("v0.7 file aliases adapt inputs and preserve legacy file_info detail semantics", () => {
    assert.deepEqual(
        adaptMcpLegacyFileToolInput("file_find", { paths: ["./src/**/*.ts"], type: "file" }),
        { patterns: ["./src/**/*.ts"], type: "file" }
    );
    assert.deepEqual(
        adaptMcpLegacyFileToolInput("file_info", { details: false, paths: ["./a.ts"] }),
        { files: [{ path: "./a.ts", view: "metadata" }] }
    );
    const current = {
        files: [{
            metadata: {
                exists: true,
                mode: 420,
                modifiedAtMs: 123,
                sizeBytes: 7,
                type: "file"
            },
            path: "./a.ts",
            view: "metadata"
        }]
    };
    assert.deepEqual(
        adaptMcpLegacyFileToolResult("file_info", current, { paths: ["./a.ts"] }),
        { entries: [{ path: "./a.ts", type: "file" }] }
    );
    assert.deepEqual(
        adaptMcpLegacyFileToolResult("file_info", current, { details: true, paths: ["./a.ts"] }),
        { entries: [{ mode: 420, modifiedAtMs: 123, path: "./a.ts", sizeBytes: 7, type: "file" }] }
    );
});

test("v0.7 tmux lifecycle names remain hidden aliases through v0.7.3", () => {
    for (const [name, command] of [
        ["tmux_list", "list"],
        ["tmux_create", "create"],
        ["tmux_close", "close"],
    ] as const) {
        const compatibility = resolveMcpLegacyTool(name);
        assert.deepEqual(compatibility, {
            command,
            kind: "tmux-v07-alias",
            removeIn: "0.7.4",
            replacement: "tmux_manage",
        }, name);
        assert.deepEqual(
            compatibility?.kind === "tmux-v07-alias"
                ? adaptMcpLegacyTmuxToolInput(compatibility, { ctxId: "ctx-a", name: "pane-a" })
                : undefined,
            { command, ctxId: "ctx-a", name: "pane-a" },
            name
        );
    }
});

test("incompatible legacy MCP schemas stay tombstoned", () => {
    for (const [name, replacement] of [
        ["context_message_read", undefined],
        ["file_write", "file_edit"],
        ["tmux_capture", "tmux_inspect"],
        ["tmux_reclaim", undefined],
        ["tmux_send", "tmux_input"],
    ] as const) {
        const compatibility = resolveMcpLegacyTool(name);
        assert.equal(compatibility?.kind, "tombstone", name);
        if (compatibility?.kind === "tombstone") {
            assert.equal(compatibility.replacement, replacement, name);
        }
    }
    assert.equal(resolveMcpLegacyTool("unknown_tool"), undefined);
});

test("control-plane MCP tools removed in 0.6.17 point cached clients to CLI", () => {
    for (const [name, help] of [
        ["artifact_share", "Use devshell artifact share, shares, or revoke."],
        ["instance_create", "Use devshell instance create."],
        ["instance_list", "Use devshell instance list."],
        ["instance_status", "Use devshell instance status <instance>."],
        ["instance_stop", "Use devshell instance stop <instance>."],
    ] as const) {
        assert.deepEqual(resolveMcpLegacyTool(name), {
            help,
            kind: "tombstone",
            removedIn: "0.6.17",
        }, name);
    }
});

test("legacy instance Context attachment points cached clients to environ_remote", () => {
    for (const name of ["instance_connect", "instance_start"] as const) {
        assert.deepEqual(resolveMcpLegacyTool(name), {
            help: "Obtain a handle with devshell instance list/status, then use environ_remote command='attach'.",
            kind: "tombstone",
            removedIn: "0.7.1",
        }, name);
    }
});
