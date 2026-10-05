import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { ToolCallHookSequence } from "../../../src/toolcall/execution/hook/Sequence.ts";
import type {
    ToolCallHookValue,
    ToolCallReviewInput,
} from "../../../src/toolcall/execution/hook/Review.ts";
import type { ToolCallRewrite } from "../../../src/toolcall/execution/hook/Rewrite.ts";

function value(payload: unknown = { command: "echo ok" }): ToolCallHookValue {
    return {
        context: {
            ctxId: "ctx-1",
            instance: asInstanceName("instance-a"),
            source: "mcp",
            workspace: "/repo",
        },
        kind: "call",
        payload: payload as never,
        toolName: "bash_run",
    };
}

function input(value: ToolCallHookValue): ToolCallReviewInput {
    return {
        callId: "call-1",
        direction: "inbound",
        value,
    };
}

test("review receives one frozen value and stops at reject", async () => {
    const outer = value({
        command: "echo ok",
        nested: { value: 1 },
    });
    const seen: Readonly<ToolCallHookValue>[] = [];
    const calls: string[] = [];
    const sequence = new ToolCallHookSequence({
        reviews: [
            async (review) => {
                calls.push("100");
                seen.push(review.value);
                assert.equal(Object.isFrozen(review.value), true);
                assert.equal(Object.isFrozen(review.value.context), true);
                assert.equal(Object.isFrozen(review.value.payload), true);
                return { decision: "continue" };
            },
            async (review) => {
                calls.push("500");
                seen.push(review.value);
                return { decision: "reject", reason: "denied" };
            },
            async () => {
                calls.push("900");
                return { decision: "continue" };
            },
        ],
    });

    const result = await sequence.review(input(outer));

    assert.deepEqual(result, { decision: "reject", reason: "denied" });
    assert.deepEqual(calls, ["100", "500"]);
    assert.equal(seen[0], seen[1]);
    assert.notEqual(seen[0], outer);
    assert.equal(Object.isFrozen(outer), false);
});

test("review and rewrite are independent pipelines", async () => {
    const calls: string[] = [];
    const sequence = new ToolCallHookSequence({
        reviews: [
            async () => {
                calls.push("review-100");
                return { decision: "continue" };
            },
            async () => {
                calls.push("review-900");
                return { decision: "continue" };
            },
        ],
        rewrites: [
            async (rewrite) => {
                calls.push("rewrite-100");
                return rewrite.value;
            },
            async (rewrite) => {
                calls.push("rewrite-900");
                return rewrite.value;
            },
        ],
    });
    const initial = value();

    await sequence.review(input(initial));
    await sequence.rewrite({
        callId: "call-1",
        direction: "inbound",
        value: initial,
    });

    assert.deepEqual(calls, [
        "review-100",
        "review-900",
        "rewrite-100",
        "rewrite-900",
    ]);
});

test("rewrite is full-value and unrestricted", async () => {
    const sequence = new ToolCallHookSequence({
        rewrites: [
            async (rewrite) => ({
                context: {
                    ...rewrite.value.context,
                    ctxId: "ctx-rewritten",
                    instance: asInstanceName("instance-b"),
                    workspace: "/rewritten",
                },
                kind: "error",
                payload: { rewritten: true },
                toolName: "file_read",
            }),
        ],
    });

    const rewritten = await sequence.rewrite({
        callId: "call-1",
        direction: "inbound",
        value: value(),
    });

    assert.deepEqual(rewritten, {
        context: {
            ctxId: "ctx-rewritten",
            instance: "instance-b",
            source: "mcp",
            workspace: "/rewritten",
        },
        kind: "error",
        payload: { rewritten: true },
        toolName: "file_read",
    });
});

test("rewrite order is forward for inbound and outbound", async () => {
    const calls: string[] = [];
    const rewrite =
        (name: string): ToolCallRewrite =>
        async (input) => {
            calls.push(`${input.direction}:${name}`);
            return {
                ...input.value,
                payload: [
                    ...(Array.isArray(input.value.payload)
                        ? input.value.payload
                        : []),
                    name,
                ],
            };
        };
    const sequence = new ToolCallHookSequence({
        rewrites: [rewrite("100"), rewrite("900")],
    });

    const inbound = await sequence.rewrite({
        callId: "call-1",
        direction: "inbound",
        value: value([]),
    });
    const outbound = await sequence.rewrite({
        callId: "call-1",
        direction: "outbound",
        value: { ...value([]), kind: "result" },
    });

    assert.deepEqual(inbound.payload, ["100", "900"]);
    assert.deepEqual(outbound.payload, ["100", "900"]);
    assert.deepEqual(calls, [
        "inbound:100",
        "inbound:900",
        "outbound:100",
        "outbound:900",
    ]);
});
