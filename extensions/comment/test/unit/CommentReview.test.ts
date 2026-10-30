import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { CommentService } from "../../src/comment/CommentService.ts";
import { MessageStore } from "../../src/message/store/MessageStore.ts";
import { createMemoryAutoHook } from "../../src/mailing/Hook.ts";
import { databaseConnection } from "../helpers/Database.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

import {
    createCommentAdvice,
    createCommentDelivery,
    createCommentRetention,
    createCommentToolCallGate,
    type CommentControlDecision,
    type CommentPort,
} from "../../src/index.ts";

const base = {
    callId: "call-comment",
    direction: "inbound" as const,
    value: {
        context: {
            ctxId: "ctx-comment",
            instance: "demo",
            requestId: "request-comment",
            source: "mcp" as const,
        },
        kind: "call" as const,
        payload: { command: "pwd" },
        toolName: "bash_run",
    },
};

type Ports = Pick<
    CommentPort,
    | "consumePending"
    | "reviewToolCall"
>;

const unusedInvocation = {
    signal: new AbortController().signal,
    async requestInterface(): Promise<never> {
        throw new Error("Comment hooks must not request a host interface");
    },
};

function createPort(overrides: Partial<Ports> = {}): Ports {
    return {
        async consumePending(_instance, _ctxId, callId) {
            return { callId, messages: [] };
        },
        async reviewToolCall() {
            return { kind: "allow" };
        },
        ...overrides,
    };
}

test("Context-scoped Extension work leaves queued Comments for the outer MCP result", async (t) => {
    const root = await createTestTempDirectory("comment-nested-delivery");
    const filePath = join(root, "message.sqlite3");
    const store = new MessageStore({
        filePath,
        instanceName: "demo",
        openDatabase: () => databaseConnection(filePath),
    });
    t.after(() => store.close());
    const events: string[] = [];
    const service = new CommentService({
        store,
        instanceName: "demo",
        appendEvent: async (type) => {
            events.push(type);
        },
    });
    const queued = await service.queue({
        ctxId: base.value.context.ctxId,
        text: "User constraint",
    });
    const delivery = createCommentDelivery({
        consumePending: async (_instance, ctxId, callId) =>
            await service.consumePending(ctxId, callId),
    });
    const auto = createMemoryAutoHook(
        {
            async ensureBound() {
                const value = {
                    ...base.value,
                    kind: "result" as const,
                    toolName: "file_read",
                    context: {
                        ...base.value.context,
                        source: "extension" as const,
                    },
                    payload: { files: [] },
                };
                assert.deepEqual(
                    await delivery(
                        {
                            callId: "internal-memory-read",
                            direction: "outbound",
                            value,
                        },
                        unusedInvocation,
                    ),
                    value,
                );
                return {
                    name: "memory",
                    directory: "/workspace/memory",
                    mailbox: "/workspace/memory/mailbox.md",
                };
            },
        },
        (error) => {
            throw error;
        },
    );
    await auto(
        {
            ...base,
            value: {
                ...base.value,
                context: { ...base.value.context, workspace: "/workspace" },
            },
        },
        unusedInvocation,
    );
    assert.equal(
        (await service.list(base.value.context.ctxId))[0]?.status,
        "sent",
    );
    const result = {
        ...base.value,
        kind: "result" as const,
        payload: { stdout: "ok" },
    };
    assert.deepEqual(
        (
            await delivery(
                { ...base, direction: "outbound", value: result },
                unusedInvocation,
            )
        ).payload,
        { stdout: "ok", comment: [queued.text] },
    );
    assert.deepEqual(
        (await service.list(base.value.context.ctxId)).map(
            ({ id, callId, status }) => ({ id, callId, status }),
        ),
        [{ id: queued.id, callId: base.callId, status: "delivered" }],
    );
    assert.equal(
        events.filter((type) => type === "context.message.delivered").length,
        1,
    );
    assert.deepEqual(
        (
            await delivery(
                { ...base, direction: "outbound", value: result },
                unusedInvocation,
            )
        ).payload,
        result.payload,
    );
});

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

    assert.deepEqual(await gate(base, unusedInvocation), {
        decision: "continue",
    });
    assert.deepEqual(calls, ["review:bash_run"]);
    assert.deepEqual(
        await gate({ ...base, direction: "outbound" }, unusedInvocation),
        { decision: "continue" },
    );
    assert.deepEqual(
        await gate(
            {
                ...base,
                value: {
                    ...base.value,
                    context: { ...base.value.context, source: "cli" as const },
                },
            },
            unusedInvocation,
        ),
        { decision: "continue" },
    );
    assert.deepEqual(
        await gate(
            {
                ...base,
                value: {
                    ...base.value,
                    context: { instance: "demo", source: "mcp" as const },
                },
            },
            unusedInvocation,
        ),
        { decision: "continue" },
    );
    assert.deepEqual(calls, ["review:bash_run"]);
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
        value: {
            ...base.value,
            kind: "result" as const,
            payload: {
                exitCode: 7,
                stderr: "",
                stdout: "",
                termination: "exited",
            },
        },
    };

    assert.deepEqual((await delivery(resultInput, unusedInvocation)).payload, {
        comment: ["User Comment"],
        exitCode: 7,
        stderr: "",
        stdout: "",
        termination: "exited",
    });
    assert.deepEqual((await advice(resultInput, unusedInvocation)).payload, {
        comment: ["[bash.nonZeroExit] Exited with code 7; inspect output."],
        exitCode: 7,
        stderr: "",
        stdout: "",
        termination: "exited",
    });
});

test("Comment is delivered on failed ToolCalls and retained unchanged when too long", async () => {
    const longComment = "用户后续要求：" + "检查甲乙丙。".repeat(800);
    const retained: Array<{ instance: string; text: string }> = [];
    const delivery = createCommentDelivery(createPort({
        async consumePending(_instance, _ctxId, callId) {
            return { callId, comment: longComment, messages: [] };
        },
    }));
    const retention = createCommentRetention(async (instance, text) => {
        retained.push({ instance, text });
        return { path: "/.devshell/tool-results/retained/stdout", sourceBytes: Buffer.byteLength(text), expiresAtMs: 12345 };
    });
    const input = {
        ...base,
        direction: "outbound" as const,
        value: {
            ...base.value,
            kind: "error" as const,
            payload: { error: { code: "tool.invalidArguments", message: "Invalid arguments", retryable: false } },
        },
    };
    const delivered = await delivery(input, unusedInvocation);
    const projected = await retention({ ...input, value: delivered }, unusedInvocation);
    const output = projected.payload as Record<string, unknown>;
    assert.deepEqual(retained, [{ instance: "demo", text: longComment }]);
    assert.equal(output.commentPath, "/.devshell/tool-results/retained/stdout");
    assert.equal(output.commentInstance, "demo");
    assert.match(String((output.comment as string[])[0]), /file_read/u);
    assert.ok(String((output.comment as string[])[0]).length < 2_000);
    assert.deepEqual((delivered.payload as { comment: string[] }).comment, [longComment]);
});

test("Comment retention failure leaves the full user message in the tool result", async () => {
    const full = "C".repeat(3_000);
    const hook = createCommentRetention(async () => { throw new Error("artifact unavailable"); });
    const input = { ...base, direction: "outbound" as const,
        value: { ...base.value, kind: "result" as const, payload: { comment: [full] } } };
    assert.equal((await hook(input, unusedInvocation)).payload, input.value.payload);
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
            "Call progress_report with a direct response to the #push message above.",
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
