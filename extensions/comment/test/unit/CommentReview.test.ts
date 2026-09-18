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

test("Comment review maps push stop and resume to rejected ToolCalls", async () => {
    const decisions: ExtensionJsonValue[] = [
        { commentId: "push-1", kind: "push", toolCallBudget: 5 },
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
            details: { commentId: "push-1", toolCallBudget: 5 },
        },
        reason: "#push response deadline reached. Call todo_report before using more tools.",
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
