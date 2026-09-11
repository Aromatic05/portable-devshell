import assert from "node:assert/strict";
import test from "node:test";

import {
    compactContextId,
    formatRelativeTime,
    humanConversationTitle,
    resolveToolOutput,
} from "@portable-devshell/shared";

test("human presentation keeps conversation identity concise and consistent", () => {
    assert.equal(compactContextId("ctx-1234567890abcdef"), "ctx-12345678…");
    assert.equal(compactContextId("ctx-short"), "ctx-short");
    assert.equal(
        humanConversationTitle({ ctxId: "ctx-long-1234567890", workspace: "/work/portable-devshell" }),
        "portable-devshell",
    );
    assert.equal(
        humanConversationTitle({ ctxId: "ctx-long-1234567890" }),
        "ctx-long-123…",
    );
});

test("human presentation formats relative time with stable buckets", () => {
    const now = Date.parse("2026-09-11T12:00:00Z");
    assert.equal(formatRelativeTime("2026-09-11T11:59:40Z", now), "just now");
    assert.equal(formatRelativeTime("2026-09-11T11:45:00Z", now), "15m ago");
    assert.equal(formatRelativeTime("2026-09-11T09:00:00Z", now), "3h ago");
    assert.equal(formatRelativeTime("2026-09-09T12:00:00Z", now), "2d ago");
    assert.equal(formatRelativeTime("invalid", now), "Unknown time");
});

test("resolveToolOutput merges durable metadata with linked stdout and stderr logs", () => {
    assert.deepEqual(
        resolveToolOutput(
            { comment: ["keep"], exitCode: 0 },
            "call-1",
            [
                { callId: "call-1", message: "out", stream: "stdout" },
                { callId: "other", message: "ignored", stream: "stdout" },
                { callId: "call-1", message: "err", stream: "stderr" },
            ],
        ),
        {
            comment: ["keep"],
            exitCode: 0,
            stderr: "err",
            stdout: "out",
        },
    );
});

test("resolveToolOutput preserves historical inline streams over reconstructed logs", () => {
    assert.deepEqual(
        resolveToolOutput(
            { exitCode: 0, stdout: "inline" },
            "call-1",
            [{ callId: "call-1", message: "log", stream: "stdout" }],
        ),
        { exitCode: 0, stdout: "inline" },
    );
});
