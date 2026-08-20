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
