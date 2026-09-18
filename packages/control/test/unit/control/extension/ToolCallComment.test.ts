import assert from "node:assert/strict";
import test from "node:test";

import { commentFeedbackInterfaceOperation, commentReviewInterfaceOperation } from "@portable-devshell/extension/comment";
import type { ToolCallReviewInvocation } from "@portable-devshell/extension/toolcall";

import { ToolCallCommentReview } from "../../../../src/control/extension/toolcall/interface/Comment.ts";

const input: ToolCallReviewInvocation = {
    context: {
        ctxId: "ctx-1",
        instance: "demo",
        requestId: "request-1",
        source: "mcp",
    },
    direction: "inbound",
    kind: "call",
    payload: { command: "pwd" },
    signal: new AbortController().signal,
    toolName: "bash_run",
};

test("ToolCall Comment interface exposes only the current review decision to the builtin Comment Extension", async () => {
    const calls: unknown[] = [];
    const review = new ToolCallCommentReview({
        feedback() {
            return [];
        },
        async reviewToolCall(
            instance: string,
            ctxId: string,
            toolName: string,
            requestId?: string,
        ) {
            calls.push({ ctxId, instance, requestId, toolName });
            return { commentId: "comment-stop", kind: "stop" as const };
        },
    });

    assert.deepEqual(
        await review
            .context("comment", input)
            .requestInterface(commentReviewInterfaceOperation),
        { commentId: "comment-stop", kind: "stop" },
    );
    assert.deepEqual(calls, [
        {
            ctxId: "ctx-1",
            instance: "demo",
            requestId: "request-1",
            toolName: "bash_run",
        },
    ]);
});

test("ToolCall Comment interface resolves outbound feedback through Comment-owned Hint logic", async () => {
    const review = new ToolCallCommentReview({
        feedback() {
            return ["[bash.nonZeroExit] Exited with code 7; inspect output."];
        },
        async reviewToolCall() {
            return { kind: "allow" as const };
        },
    });
    assert.deepEqual(
        await review
            .context("comment", {
                ...input,
                direction: "outbound",
                kind: "result",
                payload: {
                    exitCode: 7,
                    stderr: "",
                    stderrBytes: 0,
                    stderrTruncated: false,
                    stdout: "",
                    stdoutBytes: 0,
                    stdoutTruncated: false,
                    termination: "exited",
                },
            })
            .requestInterface(commentFeedbackInterfaceOperation),
        ["[bash.nonZeroExit] Exited with code 7; inspect output."],
    );
});

test("ToolCall Comment interface is invocation-scoped and unavailable to other Extensions", async () => {
    const review = new ToolCallCommentReview({
        feedback() {
            return [];
        },
        async reviewToolCall() {
            return { kind: "allow" as const };
        },
    });

    await assert.rejects(
        review
            .context("other", input)
            .requestInterface(commentReviewInterfaceOperation),
        /Unsupported ToolCall review interface operation/u,
    );
    await assert.rejects(
        review
            .context("comment", input)
            .requestInterface(commentReviewInterfaceOperation, { ctxId: "other" }),
        /does not accept Extension-provided input/u,
    );
    await assert.rejects(
        review.context("comment", input).requestInterface("comment.other"),
        /Unsupported ToolCall review interface operation/u,
    );
});
