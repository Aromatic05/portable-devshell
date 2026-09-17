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
    const lease = await bindings.acquire();
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

    await assert.rejects(bindings.acquire(), /acquire failed/u);
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

    const lease = await bindings.acquire();
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
