import assert from "node:assert/strict";
import test from "node:test";

import {
    createCommentReview,
    createCommentRewrite,
    type CommentControlDecision,
    type CommentPort,
} from "../../src/index.ts";

const base = {
    callId: "call-comment",
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

type ReviewPort = Pick<
    CommentPort,
    | "beforeTodoToolCall"
    | "consumePending"
    | "recordTodoInvalid"
    | "reviewToolCall"
>;

const unusedInvocation = {
    async requestInterface(): Promise<never> {
        throw new Error("Comment review must not request a host interface");
    },
};

function createPort(overrides: Partial<ReviewPort> = {}): ReviewPort {
    return {
        async beforeTodoToolCall() {},
        async consumePending(_instance, _ctxId, callId) {
            return { callId, messages: [] };
        },
        recordTodoInvalid() {},
        async reviewToolCall() {
            return { kind: "allow" };
        },
        ...overrides,
    };
}

test("Comment review applies model control only to inbound MCP calls with a Context", async () => {
    const calls: string[] = [];
    const review = createCommentReview(
        createPort({
            async beforeTodoToolCall(_instance, _ctxId, toolName) {
                calls.push(`before:${toolName}`);
            },
            async reviewToolCall(_instance, _ctxId, toolName) {
                calls.push(`review:${toolName}`);
                return { kind: "allow" };
            },
        }),
    );

    assert.deepEqual(await review(base, unusedInvocation), { decision: "accept" });
    assert.deepEqual(calls, ["review:bash_run", "before:bash_run"]);
    assert.deepEqual(
        await review({ ...base, direction: "outbound" }, unusedInvocation),
        { decision: "accept" },
    );
    assert.deepEqual(
        await review(
            { ...base, context: { ...base.context, source: "cli" } },
            unusedInvocation,
        ),
        { decision: "accept" },
    );
    assert.deepEqual(
        await review(
            { ...base, context: { instance: "demo", source: "mcp" } },
            unusedInvocation,
        ),
        { decision: "accept" },
    );
    assert.deepEqual(calls, ["review:bash_run", "before:bash_run"]);
});

test("Comment outbound rewrite writes queued Comment and hints into the result payload", async () => {
    const rewrite = createCommentRewrite(
        createPort({
            async consumePending(_instance, _ctxId, callId) {
                return {
                    callId,
                    comment: "User Comment",
                    messages: [],
                };
            },
        }),
    );

    assert.deepEqual(
        await rewrite(
            {
                ...base,
                direction: "outbound",
                kind: "result",
                payload: {
                    exitCode: 7,
                    stderr: "",
                    stdout: "",
                    termination: "exited",
                },
            },
            unusedInvocation,
        ),
        {
            comment: [
                "User Comment",
                "[bash.nonZeroExit] Exited with code 7; inspect output.",
            ],
            exitCode: 7,
            stderr: "",
            stdout: "",
            termination: "exited",
        },
    );
});
test("Comment review maps push stop and resume to rejected ToolCalls", async () => {
    const decisions: CommentControlDecision[] = [
        {
            comment: "#push 报告进度",
            commentId: "push-1",
            kind: "push",
            toolCallBudget: 5,
        },
        { comment: "finish this first", commentId: "stop-1", kind: "stop" },
        { comment: "continue now", commentId: "resume-1", kind: "resume" },
    ];
    const review = createCommentReview(
        createPort({
            async reviewToolCall() {
                return decisions.shift() ?? { kind: "allow" };
            },
        }),
    );

    assert.deepEqual(await review(base, unusedInvocation), {
        decision: "reject",
        error: {
            code: "control.modelReplyRequired",
            details: {
                commentId: "push-1",
                toolCallBudget: 5,
            },
        },
        reason: [
            "#push response deadline reached.",
            "You must reply to the user's #push message before using more tools.",
            "#push message: #push 报告进度",
            "Call todo_report with a direct response to the #push message above.",
        ].join("\n\n"),
    });
    assert.deepEqual(await review(base, unusedInvocation), {
        decision: "reject",
        error: {
            code: "control.modelStopped",
            details: { commentId: "stop-1" },
        },
        reason: "Stopped by user. Tool calls are disabled until the user sends #resume. User Comment: finish this first",
    });
    assert.deepEqual(await review(base, unusedInvocation), {
        decision: "reject",
        error: {
            code: "control.modelResumed",
            details: { commentId: "resume-1" },
        },
        reason: "The user sent #resume. This tool was not executed. Read the Comment before deciding the next action: continue now",
    });
});

test("Comment outbound review records invalid todo_write failures", async () => {
    const invalid: string[] = [];
    const review = createCommentReview(
        createPort({
            recordTodoInvalid(instance, ctxId) {
                invalid.push(`${instance}:${ctxId}`);
            },
        }),
    );

    assert.deepEqual(
        await review(
            {
                ...base,
                direction: "outbound",
                kind: "error",
                payload: {
                    error: {
                        code: "todo.invalid",
                        message: "invalid",
                        retryable: false,
                    },
                },
                toolName: "todo_write",
            },
            unusedInvocation,
        ),
        { decision: "accept" },
    );
    assert.deepEqual(invalid, ["demo:ctx-comment"]);
});
