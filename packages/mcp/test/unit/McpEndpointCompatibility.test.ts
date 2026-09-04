import assert from "node:assert/strict";
import test from "node:test";

import { resolveMcpLegacyTool } from "../../src/endpoint/McpEndpointCompatibility.ts";

test("legacy MCP compatibility aliases only the semantic superset", () => {
    assert.deepEqual(resolveMcpLegacyTool("ask_question"), {
        kind: "alias",
        replacement: "workspace_ask",
    });
    assert.deepEqual(resolveMcpLegacyTool("instance_start"), {
        kind: "alias",
        replacement: "instance_connect",
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
