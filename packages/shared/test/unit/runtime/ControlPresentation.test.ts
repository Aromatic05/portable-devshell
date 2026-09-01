import assert from "node:assert/strict";
import test from "node:test";

import { resolveToolOutput } from "@portable-devshell/shared";

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
