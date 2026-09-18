import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { ToolCallBoundarySequence } from "../../../src/toolcall/boundary/Sequence.ts";
import type {
    ToolCallReview,
    ToolCallReviewInput,
} from "../../../src/toolcall/boundary/Review.ts";
import type { ToolCallRewrite } from "../../../src/toolcall/boundary/Rewrite.ts";

const context = Object.freeze({
    ctxId: "ctx-1",
    instance: asInstanceName("demo"),
    source: "mcp" as const,
    workspace: "/repo",
});

function input(
    payload: ToolCallReviewInput["payload"],
): ToolCallReviewInput {
    return {
        context,
        direction: "inbound",
        kind: "call",
        payload,
        signal: new AbortController().signal,
        toolName: "bash_run",
    };
}

test("reviewers see one frozen outer payload and aggregate reject over approve over accept", async () => {
    const seen: ToolCallReviewInput["payload"][] = [];
    const decisions = ["accept", "approve", "reject"] as const;
    const reviews: ToolCallReview[] = decisions.map(
        (decision) => async (reviewInput) => {
            seen.push(reviewInput.payload);
            assert.equal(Object.isFrozen(reviewInput.payload), true);
            if (
                typeof reviewInput.payload === "object" &&
                reviewInput.payload !== null &&
                !Array.isArray(reviewInput.payload)
            ) {
                assert.equal(Object.isFrozen(reviewInput.payload.nested), true);
            }
            return { decision };
        },
    );
    const sequence = new ToolCallBoundarySequence({ reviews });
    const outer = {
        command: "curl -H 'Token: ${SECRET:github}'",
        nested: { count: 1 },
    };

    const result = await sequence.review(input(outer));

    assert.equal(result.decision, "reject");
    assert.equal(seen.length, 3);
    assert.equal(seen[0], seen[1]);
    assert.equal(seen[1], seen[2]);
    assert.notEqual(seen[0], outer);
    assert.equal(Object.isFrozen(outer), false);
});

test("review aggregates non-blocking feedback without changing decision precedence", async () => {
    const sequence = new ToolCallBoundarySequence({
        reviews: [
            async () => ({ decision: "accept", feedback: ["first"] }),
            async () => ({ decision: "approve", feedback: ["second"] }),
            async () => ({
                decision: "reject",
                feedback: ["third"],
                reason: "blocked",
            }),
        ],
    });
    assert.deepEqual(await sequence.review(input({ command: "echo ok" })), {
        decision: "reject",
        feedback: ["first", "second", "third"],
        reason: "blocked",
    });
});

test("review decision aggregation is independent of reviewer registration order", async () => {
    const makeReview = (decision: "accept" | "approve" | "reject"): ToolCallReview =>
        async () => ({ decision });
    const payload = { command: "echo ok" };

    for (const reviews of [
        [makeReview("accept"), makeReview("approve")],
        [makeReview("approve"), makeReview("accept")],
    ]) {
        const sequence = new ToolCallBoundarySequence({ reviews });
        assert.equal((await sequence.review(input(payload))).decision, "approve");
    }

    for (const reviews of [
        [makeReview("reject"), makeReview("approve")],
        [makeReview("approve"), makeReview("reject")],
    ]) {
        const sequence = new ToolCallBoundarySequence({ reviews });
        assert.equal((await sequence.review(input(payload))).decision, "reject");
    }
});

test("rewrite visits only string leaves and unwinds the stack on outbound", async () => {
    const calls: string[] = [];
    const rewrite = (name: string): ToolCallRewrite => async (rewriteInput) => {
        calls.push(
            `${rewriteInput.direction}:${name}:${rewriteInput.path.join(".")}:${rewriteInput.text}`,
        );
        return `${name}(${rewriteInput.text})`;
    };
    const sequence = new ToolCallBoundarySequence({
        rewrites: [rewrite("A"), rewrite("B")],
    });
    const payload = {
        command: "secret",
        count: 2,
        nested: [true, "tail", null],
    };

    const inbound = await sequence.rewrite({
        context,
        direction: "inbound",
        kind: "call",
        payload,
        signal: new AbortController().signal,
        toolName: "bash_run",
    });
    assert.deepEqual(inbound, {
        command: "B(A(secret))",
        count: 2,
        nested: [true, "B(A(tail))", null],
    });
    assert.deepEqual(calls, [
        "inbound:A:command:secret",
        "inbound:B:command:A(secret)",
        "inbound:A:nested.1:tail",
        "inbound:B:nested.1:A(tail)",
    ]);

    calls.length = 0;
    const outbound = await sequence.rewrite({
        context,
        direction: "outbound",
        kind: "result",
        payload: { output: "secret" },
        signal: new AbortController().signal,
        toolName: "bash_run",
    });
    assert.deepEqual(outbound, { output: "A(B(secret))" });
    assert.deepEqual(calls, [
        "outbound:B:output:secret",
        "outbound:A:output:B(secret)",
    ]);
    assert.deepEqual(payload, {
        command: "secret",
        count: 2,
        nested: [true, "tail", null],
    });
});

test("rewrite rejects non-string replacement results", async () => {
    const sequence = new ToolCallBoundarySequence({
        rewrites: [async () => 1 as never],
    });

    await assert.rejects(
        sequence.rewrite({
            context,
            direction: "inbound",
            kind: "call",
            payload: { command: "echo ok" },
            signal: new AbortController().signal,
            toolName: "bash_run",
        }),
        /must return a string/u,
    );
});

test("review handles deeply nested JSON without recursive stack growth", async () => {
    const depth = 10_000;
    let payload: ToolCallReviewInput["payload"] = "leaf";
    for (let index = 0; index < depth; index += 1) payload = [payload];
    let reviewed: ToolCallReviewInput["payload"] | undefined;
    const sequence = new ToolCallBoundarySequence({
        reviews: [async (reviewInput) => {
            reviewed = reviewInput.payload;
            return { decision: "accept" };
        }],
    });

    assert.equal((await sequence.review(input(payload))).decision, "accept");
    let current = reviewed;
    for (let index = 0; index < depth; index += 1) {
        assert.equal(Array.isArray(current), true);
        assert.equal(Object.isFrozen(current), true);
        current = (current as ToolCallReviewInput["payload"][])[0];
    }
    assert.equal(current, "leaf");
});

test("rewrite handles deeply nested JSON and materializes the leaf path once", async () => {
    const depth = 10_000;
    let payload: ToolCallReviewInput["payload"] = "leaf";
    for (let index = 0; index < depth; index += 1) payload = [payload];
    let pathLength = 0;
    const sequence = new ToolCallBoundarySequence({
        rewrites: [async (rewriteInput) => {
            pathLength = rewriteInput.path.length;
            assert.equal(rewriteInput.path.every((segment) => segment === 0), true);
            return `rewritten:${rewriteInput.text}`;
        }],
    });

    let rewritten = await sequence.rewrite({
        context,
        direction: "inbound",
        kind: "call",
        payload,
        signal: new AbortController().signal,
        toolName: "bash_run",
    });
    for (let index = 0; index < depth; index += 1) {
        assert.equal(Array.isArray(rewritten), true);
        rewritten = (rewritten as ToolCallReviewInput["payload"][])[0]!;
    }
    assert.equal(rewritten, "rewritten:leaf");
    assert.equal(pathLength, depth);
});
