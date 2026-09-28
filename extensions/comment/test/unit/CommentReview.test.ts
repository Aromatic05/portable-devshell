import assert from "node:assert/strict";
import test from "node:test";

import {
    createCommentAdvice,
    createCommentDelivery,
    createCommentTodoAccess,
    createCommentTodoInvalid,
    createCommentToolCallGate,
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

type Ports = Pick<
    CommentPort,
    | "beforeTodoToolCall"
    | "consumePending"
    | "recordTodoInvalid"
    | "reviewToolCall"
>;

const unusedInvocation = {
    async requestInterface(): Promise<never> {
        throw new Error("Comment hooks must not request a host interface");
    },
};

function createPort(overrides: Partial<Ports> = {}): Ports {
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

test("Comment toolcall gate applies model control only to inbound MCP calls with a Context", async () => {
    const calls: string[] = [];
    const gate = createCommentToolCallGate(
        createPort({
            async reviewToolCall(_instance, _ctxId, toolName) {
                calls.push(`review:${toolName}`);
                return { kind: "allow" };
            },
        }),
    );

    assert.deepEqual(await gate(base, unusedInvocation), { decision: "accept" });
    assert.deepEqual(calls, ["review:bash_run"]);
    assert.deepEqual(
        await gate({ ...base, direction: "outbound" }, unusedInvocation),
        { decision: "accept" },
    );
    assert.deepEqual(
        await gate(
            { ...base, context: { ...base.context, source: "cli" } },
            unusedInvocation,
        ),
        { decision: "accept" },
    );
    assert.deepEqual(
        await gate(
            { ...base, context: { instance: "demo", source: "mcp" } },
            unusedInvocation,
        ),
        { decision: "accept" },
    );
    assert.deepEqual(calls, ["review:bash_run"]);
});

test("Comment todo-access hook consumes Todo access on admitted inbound MCP calls only", async () => {
    const calls: string[] = [];
    const access = createCommentTodoAccess(
        createPort({
            async beforeTodoToolCall(_instance, _ctxId, toolName) {
                calls.push(`before:${toolName}`);
            },
        }),
    );

    assert.deepEqual(await access(base, unusedInvocation), base.payload);
    assert.deepEqual(calls, ["before:bash_run"]);
    assert.deepEqual(
        await access({ ...base, direction: "outbound" }, unusedInvocation),
        base.payload,
    );
    assert.deepEqual(
        await access(
            { ...base, context: { ...base.context, source: "cli" } },
            unusedInvocation,
        ),
        base.payload,
    );
    assert.deepEqual(
        await access(
            { ...base, context: { instance: "demo", source: "mcp" } },
            unusedInvocation,
        ),
        base.payload,
    );
    assert.deepEqual(calls, ["before:bash_run"]);
});

test("Comment delivery hook writes the queued Comment and the advice hook appends hints independently", async () => {
    const delivery = createCommentDelivery(
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
    const advice = createCommentAdvice();
    const resultInput = {
        ...base,
        direction: "outbound" as const,
        kind: "result" as const,
        payload: {
            exitCode: 7,
            stderr: "",
            stdout: "",
            termination: "exited",
        },
    };

    assert.deepEqual(await delivery(resultInput, unusedInvocation), {
        comment: ["User Comment"],
        exitCode: 7,
        stderr: "",
        stdout: "",
        termination: "exited",
    });
    assert.deepEqual(await advice(resultInput, unusedInvocation), {
        comment: ["[bash.nonZeroExit] Exited with code 7; inspect output."],
        exitCode: 7,
        stderr: "",
        stdout: "",
        termination: "exited",
    });
});

test("Comment toolcall gate maps push stop and resume to rejected ToolCalls", async () => {
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
    const gate = createCommentToolCallGate(
        createPort({
            async reviewToolCall() {
                return decisions.shift() ?? { kind: "allow" };
            },
        }),
    );

    assert.deepEqual(await gate(base, unusedInvocation), {
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
    assert.deepEqual(await gate(base, unusedInvocation), {
        decision: "reject",
        error: {
            code: "control.modelStopped",
            details: { commentId: "stop-1" },
        },
        reason: "Stopped by user. Tool calls are disabled until the user sends #resume. User Comment: finish this first",
    });
    assert.deepEqual(await gate(base, unusedInvocation), {
        decision: "reject",
        error: {
            code: "control.modelResumed",
            details: { commentId: "resume-1" },
        },
        reason: "The user sent #resume. This tool was not executed. Read the Comment before deciding the next action: continue now",
    });
});

test("Comment todo-invalid hook records invalid todo_write failures and the advice hook explains them", async () => {
    const invalid: string[] = [];
    const todoInvalid = createCommentTodoInvalid(
        createPort({
            recordTodoInvalid(instance, ctxId) {
                invalid.push(`${instance}:${ctxId}`);
            },
        }),
    );
    const advice = createCommentAdvice();
    const errorInput = {
        ...base,
        direction: "outbound" as const,
        kind: "error" as const,
        payload: {
            error: {
                code: "todo.invalid",
                message: "invalid",
                retryable: false,
            },
        },
        toolName: "todo_write",
    };

    const recorded = await todoInvalid(errorInput, unusedInvocation);
    assert.deepEqual(recorded, errorInput.payload);
    assert.deepEqual(invalid, ["demo:ctx-comment"]);
    assert.deepEqual(await advice({ ...errorInput, payload: recorded }, unusedInvocation), {
        comment: [
            "[todo.invalid] Fix the reported invariant and resubmit the full plan.",
        ],
        error: {
            code: "todo.invalid",
            message: "invalid",
            retryable: false,
        },
    });
});