import assert from "node:assert/strict";
import test from "node:test";

import type {
    ToolCallReviewBinding,
    ToolCallRewriteBinding,
} from "@portable-devshell/extension/toolcall";
import { asInstanceName } from "@portable-devshell/shared";

import { ToolCallExtensionBinding } from "../../../../src/control/extension/toolcall/Binding.ts";
import {
    toolCallReviewSandboxCodec,
    toolCallRewriteSandboxCodec,
} from "../../../../src/control/extension/toolcall/Sandbox.ts";

const context = {
    instance: asInstanceName("instance-a"),
    source: "mcp" as const,
};

const value = {
    context,
    kind: "call" as const,
    payload: { command: "echo ok" },
    toolName: "bash_run",
};

function host(options: {
    reviews?: Array<{
        binding: ToolCallReviewBinding;
        extensionId?: string;
        hook: string;
        id: string;
    }>;
    rewrites?: Array<{
        binding: ToolCallRewriteBinding;
        extensionId?: string;
        hook: string;
        id: string;
    }>;
    releases?: string[];
}) {
    const reviews = options.reviews ?? [];
    const rewrites = options.rewrites ?? [];
    return {
        listDeclarations(pointId: string) {
            const entries = pointId === "toolcall.review" ? reviews : rewrites;
            return entries.map(({ extensionId, hook, id }) => ({
                declaration: { hook, id },
                extensionId,
                id,
            }));
        },
        async acquireRegistration(pointId: string, id: string) {
            const entries = pointId === "toolcall.review" ? reviews : rewrites;
            const entry = entries.find((candidate) => candidate.id === id);
            assert.ok(entry);
            return {
                extensionId: entry.extensionId,
                lease: {
                    release() {
                        options.releases?.push(id);
                    },
                },
                registration: { binding: entry.binding },
            };
        },
    };
}

test("ToolCall review pipeline places builtin approval at 510-approval", async () => {
    const calls: string[] = [];
    const binding = new ToolCallExtensionBinding(
        host({
            reviews: [
                {
                    hook: "900-late",
                    id: "late",
                    binding: async () => {
                        calls.push("late");
                        return { decision: "continue" };
                    },
                },
                {
                    hook: "500-early",
                    id: "early",
                    binding: async () => {
                        calls.push("early");
                        return { decision: "continue" };
                    },
                },
            ],
        }) as never,
        undefined,
        async () => {
            calls.push("approval");
            return { decision: "continue" };
        },
    );
    const lease = await binding.acquire(
        context,
        new AbortController().signal,
        "host",
    );

    assert.deepEqual(
        await lease.sequence.review({
            callId: "call-1",
            direction: "inbound",
            value,
        }),
        { decision: "continue" },
    );
    assert.deepEqual(calls, ["early", "approval", "late"]);
    lease.release();
});

test("approval rejection short-circuits later reviews", async () => {
    const calls: string[] = [];
    const binding = new ToolCallExtensionBinding(
        host({
            reviews: [
                {
                    hook: "500-early",
                    id: "early",
                    binding: async () => {
                        calls.push("early");
                        return { decision: "continue" };
                    },
                },
                {
                    hook: "900-late",
                    id: "late",
                    binding: async () => {
                        calls.push("late");
                        return { decision: "continue" };
                    },
                },
            ],
        }) as never,
        undefined,
        async () => {
            calls.push("approval");
            return { decision: "reject", reason: "denied" };
        },
    );
    const lease = await binding.acquire(
        context,
        new AbortController().signal,
        "host",
    );

    assert.deepEqual(
        await lease.sequence.review({
            callId: "call-1",
            direction: "inbound",
            value,
        }),
        { decision: "reject", reason: "denied" },
    );
    assert.deepEqual(calls, ["early", "approval"]);
    lease.release();
});

test("review and rewrite ordering are independent", async () => {
    const reviewCalls: string[] = [];
    const rewriteCalls: string[] = [];
    const rewrite = (name: string): ToolCallRewriteBinding => async (input) => {
        rewriteCalls.push(name);
        return {
            ...input.value,
            payload: {
                trace: [
                    ...((input.value.payload as { trace?: string[] }).trace ?? []),
                    name,
                ],
            },
        };
    };
    const binding = new ToolCallExtensionBinding(
        host({
            reviews: [
                {
                    hook: "900-review",
                    id: "review-late",
                    binding: async () => {
                        reviewCalls.push("900");
                        return { decision: "continue" };
                    },
                },
                {
                    hook: "500-review",
                    id: "review-early",
                    binding: async () => {
                        reviewCalls.push("500");
                        return { decision: "continue" };
                    },
                },
            ],
            rewrites: [
                { hook: "900-rewrite", id: "rewrite-late", binding: rewrite("900") },
                { hook: "500-rewrite", id: "rewrite-early", binding: rewrite("500") },
            ],
        }) as never,
    );
    const lease = await binding.acquire(
        context,
        new AbortController().signal,
        "host",
    );

    await lease.sequence.review({
        callId: "call-1",
        direction: "inbound",
        value,
    });
    const rewritten = await lease.sequence.rewrite({
        callId: "call-1",
        direction: "inbound",
        value: { ...value, payload: { trace: [] } },
    });

    assert.deepEqual(reviewCalls, ["500", "900"]);
    assert.deepEqual(rewriteCalls, ["500", "900"]);
    assert.deepEqual(rewritten.payload, { trace: ["500", "900"] });
    lease.release();
});

test("ToolCall binding holds exact registration leases for the call", async () => {
    const releases: string[] = [];
    const binding = new ToolCallExtensionBinding(
        host({
            releases,
            reviews: [
                {
                    hook: "500-review",
                    id: "review",
                    binding: async () => ({ decision: "continue" }),
                },
            ],
            rewrites: [
                {
                    hook: "100-rewrite",
                    id: "rewrite",
                    binding: async (input) => input.value,
                },
            ],
        }) as never,
    );

    const lease = await binding.acquire(
        context,
        new AbortController().signal,
        "host",
    );
    assert.deepEqual(releases, []);
    lease.release();
    assert.deepEqual(releases, ["rewrite", "review"]);
});

test("ToolCall sandbox codecs expose only callId direction value and context signal", async () => {
    const signal = new AbortController().signal;
    const review = await toolCallReviewSandboxCodec.invokeBinding(
        async (input, invocation) => {
            assert.deepEqual(Object.keys(input).sort(), [
                "callId",
                "direction",
                "value",
            ]);
            assert.equal(invocation.signal, signal);
            assert.deepEqual(input.value, {
                context: {
                    instance: "instance-a",
                    source: "mcp",
                },
                kind: "call",
                payload: { command: "echo ok" },
                toolName: "bash_run",
            });
            return { decision: "continue" };
        },
        {
            callId: "call-1",
            direction: "inbound",
            value: {
                context: { instance: "instance-a", source: "mcp" },
                kind: "call",
                payload: { command: "echo ok" },
                toolName: "bash_run",
            },
        },
        signal,
        { requestInterface: async () => undefined } as never,
    );
    assert.deepEqual(review, { decision: "continue" });

    const rewritten = await toolCallRewriteSandboxCodec.invokeBinding(
        async (input, invocation) => {
            assert.deepEqual(Object.keys(input).sort(), [
                "callId",
                "direction",
                "value",
            ]);
            assert.equal(invocation.signal, signal);
            return {
                context: {
                    ...input.value.context,
                    instance: "instance-b",
                },
                kind: "error",
                payload: { rewritten: true },
                toolName: "file_read",
            };
        },
        {
            callId: "call-1",
            direction: "outbound",
            value: {
                context: { instance: "instance-a", source: "mcp" },
                kind: "result",
                payload: { ok: true },
                toolName: "bash_run",
            },
        },
        signal,
        { requestInterface: async () => undefined } as never,
    );
    assert.deepEqual(rewritten, {
        context: { instance: "instance-b", source: "mcp" },
        kind: "error",
        payload: { rewritten: true },
        toolName: "file_read",
    });
});
