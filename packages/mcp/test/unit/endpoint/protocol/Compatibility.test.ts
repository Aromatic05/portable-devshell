import assert from "node:assert/strict";
import test from "node:test";

import { resolveMcpLegacyTool } from "../../../../src/protocol/tool/Compatibility.ts";

test("v0.6.15 MCP App protocol remains a hidden wire compatibility surface", () => {
    for (const [name, replacement] of [
        ["workspace_goal_continue", "mcpapp_reentry"],
        ["workspace_reentry_control", "mcpapp_reentry"],
    ] as const) {
        assert.deepEqual(
            resolveMcpLegacyTool(name),
            {
                kind: "workspace-app-v0615",
                replacement,
            },
            name,
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
        assert.deepEqual(
            resolveMcpLegacyTool(name),
            {
                help,
                kind: "tombstone",
                removedIn: "0.6.17",
            },
            name,
        );
    }
});

test("legacy instance Context attachment points cached clients to environ_remote", () => {
    for (const name of ["instance_connect", "instance_start"] as const) {
        assert.deepEqual(
            resolveMcpLegacyTool(name),
            {
                help: "Obtain a handle with devshell instance list/status, then use environ_remote command='attach'.",
                kind: "tombstone",
                removedIn: "0.7.1",
            },
            name,
        );
    }
});
