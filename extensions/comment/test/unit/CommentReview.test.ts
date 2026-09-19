import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionJsonValue } from "@portable-devshell/extension";

import { createCommentReview } from "../../src/builtin/CommentReview.ts";

const base = {
    context: {
        ctxId: "ctx-comment",
        instance: "demo",
        requestId: "request-comment",
        source: "mcp" as const,
    },
    direction: "inbound" as const,
    kind: "call" as const,
    payload: { command: "pwd" },
    signal: new AbortController().signal,
    toolName: "bash_run",
};

test("Comment review applies model control only to inbound MCP calls with a Context", async () => {
    const calls: unknown[] = [];
    const review = createCommentReview();
    const invocation = {
        async requestInterface(operation: string, input?: unknown) {
            calls.push({ input, operation });
            return { kind: "allow" };
        },
    };

    assert.deepEqual(await review(base, invocation), { decision: "accept" });
    assert.deepEqual(calls, [
        { input: undefined, operation: "comment.reviewToolCall" },
    ]);
    assert.deepEqual(await review({ ...base, direction: "outbound" }, invocation), { decision: "accept" });
    assert.deepEqual(await review({ ...base, context: { ...base.context, source: "cli" } }, invocation), { decision: "accept" });
    assert.deepEqual(await review({ ...base, context: { instance: "demo", source: "mcp" } }, invocation), { decision: "accept" });
    assert.equal(calls.length, 1);
});

test("Comment outbound review returns non-blocking feedback", async () => {
    const calls: unknown[] = [];
    const review = createCommentReview();
    const invocation = {
        async requestInterface(operation: string, input?: unknown) {
            calls.push({ input, operation });
            if (operation === "comment.feedback")
                return ["[bash.nonZeroExit] Exited with code 7; inspect output."];
            throw new Error(`unexpected operation ${operation}`);
        },
    };

    assert.deepEqual(
        await review(
            {
                ...base,
                direction: "outbound",
                kind: "result",
                payload: { exitCode: 7 },
            },
            invocation,
        ),
        {
            decision: "accept",
            feedback: ["[bash.nonZeroExit] Exited with code 7; inspect output."],
        },
    );
    assert.deepEqual(calls, [
        { input: undefined, operation: "comment.feedback" },
    ]);
});

test("Comment review maps push stop and resume to rejected ToolCalls", async () => {
    const decisions: ExtensionJsonValue[] = [
        {
            comment: "Explain the original failure",
            commentId: "push-1",
            kind: "push",
            replyCommentId: "question-1",
            toolCallBudget: 5,
        },
        { comment: "finish this first", commentId: "stop-1", kind: "stop" },
        { comment: "continue now", commentId: "resume-1", kind: "resume" },
    ];
    const review = createCommentReview();
    const invocation = {
        async requestInterface() {
            return decisions.shift() ?? { kind: "allow" as const };
        },
    };

    assert.deepEqual(await review(base, invocation), {
        decision: "reject",
        error: {
            code: "control.modelReplyRequired",
            details: {
                commentId: "push-1",
                replyCommentId: "question-1",
                toolCallBudget: 5,
            },
        },
        reason: [
            "#push response deadline reached.",
            "You must reply to the pending user Comment before using more tools.",
            "Pending user Comment: Explain the original failure",
            "Call todo_report with a direct response to the Comment above.",
        ].join("\n\n"),
    });
    assert.deepEqual(await review(base, invocation), {
        decision: "reject",
        error: {
            code: "control.modelStopped",
            details: { commentId: "stop-1" },
        },
        reason: "Stopped by user. Tool calls are disabled until the user sends #resume. User Comment: finish this first",
    });
    assert.deepEqual(await review(base, invocation), {
        decision: "reject",
        error: {
            code: "control.modelResumed",
            details: { commentId: "resume-1" },
        },
        reason: "The user sent #resume. This tool was not executed. Read the Comment before deciding the next action: continue now",
    });
});
