import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";
import { reviewCommentToolCall } from "@portable-devshell/extension/comment";
import { readSecretEnvironment } from "@portable-devshell/extension/secret";
import type {
    ToolCallReviewInvocation,
    ToolCallRewriteInvocation,
} from "@portable-devshell/extension/toolcall";

import { ToolCallExtensionBinding } from "../../../../src/control/extension/toolcall/Binding.ts";
import { ToolCallCommentReview } from "../../../../src/control/extension/toolcall/interface/Comment.ts";
import { ToolCallSecretRewrite } from "../../../../src/control/extension/toolcall/interface/Secret.ts";
import {
    createToolCallReviewSandboxBinding,
    createToolCallRewriteSandboxBinding,
    toolCallReviewSandboxCodec,
    toolCallRewriteSandboxCodec,
} from "../../../../src/control/extension/toolcall/Sandbox.ts";

const validationContext = Object.freeze({
    codeDirectory: "/extension",
    extensionId: "example",
    id: "entry",
});

const toolCallContext = Object.freeze({
    ctxId: "ctx-1",
    instance: asInstanceName("demo"),
    source: "mcp" as const,
    workspace: "/repo",
});

test("ToolCall Extension binding acquires registrations once and releases them with the Boundary lease", async () => {
    const events: string[] = [];
    const bindings = new ToolCallExtensionBinding({
        listDeclarations(pointId: string) {
            return pointId === "toolcall.review"
                ? [{ id: "comment" }]
                : pointId === "toolcall.rewrite"
                  ? [{ id: "secret" }]
                  : [];
        },
        async acquireRegistration(pointId: string, id: string) {
            events.push(`acquire:${pointId}:${id}`);
            return {
                lease: {
                    release() {
                        events.push(`release:${pointId}:${id}`);
                    },
                },
                registration: {
                    binding:
                        pointId === "toolcall.review"
                            ? async () => ({ decision: "approve" as const })
                            : async (input: { text: string }) =>
                                  `masked(${input.text})`,
                },
            } as never;
        },
    } as never);
    const lease = await bindings.acquire(toolCallContext);
    const signal = new AbortController().signal;

    assert.deepEqual(
        await lease.sequence.review({
            context: toolCallContext,
            direction: "inbound",
            kind: "call",
            payload: { command: "echo ok" },
            signal,
            toolName: "bash_run",
        }),
        { decision: "approve" },
    );
    assert.equal(
        await lease.sequence.rewrite({
            context: toolCallContext,
            direction: "outbound",
            kind: "result",
            payload: "secret",
            signal,
            toolName: "bash_run",
        }),
        "masked(secret)",
    );
    assert.deepEqual(events, [
        "acquire:toolcall.review:comment",
        "acquire:toolcall.rewrite:secret",
    ]);
    lease.release();
    assert.deepEqual(events, [
        "acquire:toolcall.review:comment",
        "acquire:toolcall.rewrite:secret",
        "release:toolcall.rewrite:secret",
        "release:toolcall.review:comment",
    ]);
});

test("ToolCall Extension binding supplies the same scoped Comment interface to in-process review bindings", async () => {
    const comment = new ToolCallCommentReview({
        get(instance: string) {
            assert.equal(instance, "demo");
            return {
                contextMessages: {
                    async reviewToolCall() {
                        return { commentId: "stop-1", kind: "stop" as const };
                    },
                },
            } as never;
        },
    });
    const bindings = new ToolCallExtensionBinding(
        {
            listDeclarations(pointId: string) {
                return pointId === "toolcall.review"
                    ? [{ extensionId: "comment", id: "comment" }]
                    : [];
            },
            async acquireRegistration() {
                return {
                    extensionId: "comment",
                    lease: { release() {} },
                    registration: {
                        binding: async (_input: unknown, context: Parameters<typeof reviewCommentToolCall>[0]) =>
                            (await reviewCommentToolCall(context)).kind === "stop"
                                ? { decision: "reject" as const, reason: "stop" }
                                : { decision: "accept" as const },
                    },
                } as never;
            },
        } as never,
        comment,
    );
    const lease = await bindings.acquire(toolCallContext);
    try {
        assert.deepEqual(
            await lease.sequence.review({
                context: toolCallContext,
                direction: "inbound",
                kind: "call",
                payload: { command: "pwd" },
                signal: new AbortController().signal,
                toolName: "bash_run",
            }),
            { decision: "reject", reason: "stop" },
        );
    } finally {
        lease.release();
    }
});

test("ToolCall Extension binding pins one Secret env snapshot for inbound and outbound", async () => {
    let token = "real-token";
    const secret = new ToolCallSecretRewrite(
        () =>
            ({
                instances: [
                    {
                        env: { TOKEN: token },
                        name: "demo",
                    },
                ],
            }) as never,
    );
    const bindings = new ToolCallExtensionBinding(
        {
            listDeclarations(pointId: string) {
                return pointId === "toolcall.rewrite"
                    ? [{ extensionId: "secret", id: "secret" }]
                    : [];
            },
            async acquireRegistration() {
                return {
                    extensionId: "secret",
                    lease: { release() {} },
                    registration: {
                        binding: async (
                            input: ToolCallRewriteInvocation,
                            context: Parameters<typeof readSecretEnvironment>[0],
                        ) => {
                            const environment = await readSecretEnvironment(context);
                            return input.direction === "inbound"
                                ? input.text.replace(
                                      "${SECRET:TOKEN}",
                                      environment.TOKEN!,
                                  )
                                : input.text.replace(
                                      environment.TOKEN!,
                                      "${SECRET:TOKEN}",
                                  );
                        },
                    },
                } as never;
            },
        } as never,
        new ToolCallCommentReview(),
        secret,
    );
    const lease = await bindings.acquire(toolCallContext);
    try {
        const signal = new AbortController().signal;
        assert.equal(
            await lease.sequence.rewrite({
                context: toolCallContext,
                direction: "inbound",
                kind: "call",
                payload: "echo ${SECRET:TOKEN}",
                signal,
                toolName: "bash_run",
            }),
            "echo real-token",
        );
        token = "new-token";
        assert.equal(
            await lease.sequence.rewrite({
                context: toolCallContext,
                direction: "outbound",
                kind: "result",
                payload: "result real-token",
                signal,
                toolName: "bash_run",
            }),
            "result ${SECRET:TOKEN}",
        );
    } finally {
        lease.release();
    }

    const nextLease = await bindings.acquire(toolCallContext);
    try {
        assert.equal(
            await nextLease.sequence.rewrite({
                context: toolCallContext,
                direction: "inbound",
                kind: "call",
                payload: "echo ${SECRET:TOKEN}",
                signal: new AbortController().signal,
                toolName: "bash_run",
            }),
            "echo new-token",
        );
    } finally {
        nextLease.release();
    }
});

test("ToolCall Extension binding rolls back acquired generation leases when acquisition fails", async () => {
    const events: string[] = [];
    const bindings = new ToolCallExtensionBinding({
        listDeclarations(pointId: string) {
            return pointId === "toolcall.review"
                ? [{ id: "one" }, { id: "two" }]
                : [];
        },
        async acquireRegistration(_pointId: string, id: string) {
            if (id === "two") throw new Error("acquire failed");
            return {
                lease: {
                    release() {
                        events.push("release:one");
                    },
                },
                registration: { binding: async () => ({ decision: "accept" }) },
            } as never;
        },
    } as never);

    await assert.rejects(bindings.acquire(toolCallContext), /acquire failed/u);
    assert.deepEqual(events, ["release:one"]);
});

test("ToolCall sandbox review binding preserves outer invocation fields and AbortSignal", async () => {
    const signal = new AbortController().signal;
    const calls: unknown[] = [];
    const binding = createToolCallReviewSandboxBinding(
        { kind: "review" },
        validationContext,
        {
            async invokeBinding(pointId, id, input, options) {
                calls.push({ id, input, pointId, signal: options?.signal });
                return {
                    decision: "reject",
                    error: {
                        code: "control.modelStopped",
                        details: { commentId: "stop-1" },
                    },
                    reason: "blocked",
                };
            },
        },
    );

    assert.deepEqual(
        await binding(
            {
                context: toolCallContext,
                direction: "inbound",
                kind: "call",
                payload: { command: "echo ok" },
                signal,
                toolName: "bash_run",
            },
            {
                async requestInterface() {
                    throw new Error("not used");
                },
            },
        ),
        {
            decision: "reject",
            error: {
                code: "control.modelStopped",
                details: { commentId: "stop-1" },
            },
            reason: "blocked",
        },
    );
    assert.deepEqual(calls, [
        {
            id: "entry",
            input: {
                context: {
                    ctxId: "ctx-1",
                    instance: "demo",
                    source: "mcp",
                    workspace: "/repo",
                },
                direction: "inbound",
                kind: "call",
                payload: { command: "echo ok" },
                toolName: "bash_run",
            },
            pointId: "toolcall.review",
            signal,
        },
    ]);
});

test("ToolCall sandbox codecs decode review and rewrite invocations without exposing transport details", async () => {
    const signal = new AbortController().signal;
    let reviewSignal: AbortSignal | undefined;
    let rewriteSignal: AbortSignal | undefined;

    assert.deepEqual(
        await toolCallReviewSandboxCodec.invokeBinding(
            async (input: ToolCallReviewInvocation) => {
                reviewSignal = input.signal;
                assert.deepEqual(input.payload, { output: "safe" });
                return {
                    decision: "reject",
                    error: {
                        code: "control.modelReplyRequired",
                        details: { commentId: "push-1", toolCallBudget: 5 },
                    },
                    reason: "reply first",
                };
            },
            {
                context: { instance: "demo", source: "mcp" },
                direction: "outbound",
                kind: "result",
                payload: { output: "safe" },
                toolName: "bash_run",
            },
            signal,
            {
                ...validationContext,
                async requestInterface() {
                    throw new Error("not used");
                },
            },
        ),
        {
            decision: "reject",
            error: {
                code: "control.modelReplyRequired",
                details: { commentId: "push-1", toolCallBudget: 5 },
            },
            reason: "reply first",
        },
    );

    assert.equal(
        await toolCallRewriteSandboxCodec.invokeBinding(
            async (input: ToolCallRewriteInvocation) => {
                rewriteSignal = input.signal;
                assert.deepEqual(input.path, ["stdout", 0]);
                return `mask(${input.text})`;
            },
            {
                context: { instance: "demo", source: "mcp" },
                direction: "outbound",
                kind: "progress",
                path: ["stdout", 0],
                text: "secret",
                toolName: "bash_run",
            },
            signal,
            {
                ...validationContext,
                async requestInterface() {
                    throw new Error("not used");
                },
            },
        ),
        "mask(secret)",
    );
    assert.equal(reviewSignal, signal);
    assert.equal(rewriteSignal, signal);

    const rewriteBinding = createToolCallRewriteSandboxBinding(
        { kind: "rewrite" },
        validationContext,
        {
            async invokeBinding(pointId, id, input, options) {
                assert.equal(pointId, "toolcall.rewrite");
                assert.equal(id, "entry");
                assert.equal(options?.signal, signal);
                assert.deepEqual(input, {
                    context: {
                        ctxId: "ctx-1",
                        instance: "demo",
                        source: "mcp",
                        workspace: "/repo",
                    },
                    direction: "inbound",
                    kind: "call",
                    path: ["command"],
                    text: "${SECRET:github}",
                    toolName: "bash_run",
                });
                return "expanded";
            },
        },
    );
    assert.equal(
        await rewriteBinding(
            {
                context: toolCallContext,
                direction: "inbound",
                kind: "call",
                path: ["command"],
                signal,
                text: "${SECRET:github}",
                toolName: "bash_run",
            },
            {
                async requestInterface() {
                    throw new Error("not used");
                },
            },
        ),
        "expanded",
    );
});

test("ToolCall Boundary holds exact Extension generation leases for the whole call", async () => {
    const events: string[] = [];
    let generation = "g1";
    const bindings = new ToolCallExtensionBinding({
        listDeclarations(pointId: string) {
            return pointId === "toolcall.rewrite" ? [{ id: "secret" }] : [];
        },
        async acquireRegistration(pointId: string, id: string) {
            const acquired = generation;
            events.push(`acquire:${pointId}:${id}:${acquired}`);
            return {
                lease: {
                    release() {
                        events.push(`release:${pointId}:${id}:${acquired}`);
                    },
                },
                registration: {
                    binding: async (input: { text: string }) =>
                        `${acquired}(${input.text})`,
                },
            } as never;
        },
    } as never);

    const lease = await bindings.acquire(toolCallContext);
    generation = "g2";
    const signal = new AbortController().signal;
    assert.deepEqual(
        await lease.sequence.rewrite({
            context: toolCallContext,
            direction: "inbound",
            kind: "call",
            payload: "secret",
            signal,
            toolName: "bash_run",
        }),
        "g1(secret)",
    );
    assert.deepEqual(
        await lease.sequence.rewrite({
            context: toolCallContext,
            direction: "outbound",
            kind: "result",
            payload: "secret",
            signal,
            toolName: "bash_run",
        }),
        "g1(secret)",
    );
    assert.deepEqual(events, ["acquire:toolcall.rewrite:secret:g1"]);
    lease.release();
    assert.deepEqual(events, [
        "acquire:toolcall.rewrite:secret:g1",
        "release:toolcall.rewrite:secret:g1",
    ]);
});
