import assert from "node:assert/strict";
import test from "node:test";

import { ToolCallExtensionBinding } from "../../../../src/control/extension/toolcall/Binding.ts";
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
    source: "mcp" as const,
    workspace: "/repo",
});

test("ToolCall Extension bindings acquire and release one generation lease per invocation", async () => {
    const events: string[] = [];
    const host = {
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
            };
        },
    };
    const bindings = new ToolCallExtensionBinding(host as never);
    const signal = new AbortController().signal;

    assert.deepEqual(
        await bindings.reviews()[0]!({
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
        await bindings.rewrites()[0]!({
            context: toolCallContext,
            direction: "outbound",
            kind: "result",
            path: ["stdout"],
            signal,
            text: "secret",
            toolName: "bash_run",
        }),
        "masked(secret)",
    );
    assert.deepEqual(events, [
        "acquire:toolcall.review:comment",
        "release:toolcall.review:comment",
        "acquire:toolcall.rewrite:secret",
        "release:toolcall.rewrite:secret",
    ]);
});

test("ToolCall Extension binding releases the generation lease when a binding fails", async () => {
    let releases = 0;
    const bindings = new ToolCallExtensionBinding({
        listDeclarations() {
            return [{ id: "guard" }] as never;
        },
        async acquireRegistration() {
            return {
                lease: {
                    release() {
                        releases += 1;
                    },
                },
                registration: {
                    binding: async () => {
                        throw new Error("review failed");
                    },
                },
            } as never;
        },
    });

    await assert.rejects(
        bindings.reviews()[0]!({
            context: toolCallContext,
            direction: "inbound",
            kind: "call",
            payload: {},
            signal: new AbortController().signal,
            toolName: "bash_run",
        }),
        /review failed/u,
    );
    assert.equal(releases, 1);
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
                return { decision: "reject", reason: "blocked" };
            },
        },
    );

    assert.deepEqual(
        await binding({
            context: toolCallContext,
            direction: "inbound",
            kind: "call",
            payload: { command: "echo ok" },
            signal,
            toolName: "bash_run",
        }),
        { decision: "reject", reason: "blocked" },
    );
    assert.deepEqual(calls, [
        {
            id: "entry",
            input: {
                context: {
                    ctxId: "ctx-1",
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
            async (input) => {
                reviewSignal = input.signal;
                assert.deepEqual(input.payload, { output: "safe" });
                return { decision: "accept" };
            },
            {
                context: { source: "mcp" },
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
        { decision: "accept" },
    );

    assert.equal(
        await toolCallRewriteSandboxCodec.invokeBinding(
            async (input) => {
                rewriteSignal = input.signal;
                assert.deepEqual(input.path, ["stdout", 0]);
                return `mask(${input.text})`;
            },
            {
                context: { source: "mcp" },
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
        await rewriteBinding({
            context: toolCallContext,
            direction: "inbound",
            kind: "call",
            path: ["command"],
            signal,
            text: "${SECRET:github}",
            toolName: "bash_run",
        }),
        "expanded",
    );
});
