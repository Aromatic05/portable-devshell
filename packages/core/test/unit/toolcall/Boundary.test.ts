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
        callId: "call-review",
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

test("rewrite passes the whole payload through hooks and unwinds on outbound", async () => {
    const calls: string[] = [];
    const rewrite = (name: string): ToolCallRewrite => async (rewriteInput) => {
        const payload = rewriteInput.payload as Record<string, unknown>;
        const trace = Array.isArray(payload.trace) ? payload.trace : [];
        calls.push(`${rewriteInput.direction}:${name}:${trace.join(",")}`);
        return { ...payload, trace: [...trace, name] };
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
        callId: "call-1",
        context,
        direction: "inbound",
        kind: "call",
        payload,
        signal: new AbortController().signal,
        toolName: "bash_run",
    });
    assert.deepEqual(inbound, {
        command: "secret",
        count: 2,
        nested: [true, "tail", null],
        trace: ["A", "B"],
    });
    assert.deepEqual(calls, ["inbound:A:", "inbound:B:A"]);

    calls.length = 0;
    const outbound = await sequence.rewrite({
        callId: "call-1",
        context,
        direction: "outbound",
        kind: "result",
        payload: { output: "secret" },
        signal: new AbortController().signal,
        toolName: "bash_run",
    });
    assert.deepEqual(outbound, { output: "secret", trace: ["B", "A"] });
    assert.deepEqual(calls, ["outbound:B:", "outbound:A:B"]);
    assert.deepEqual(payload, {
        command: "secret",
        count: 2,
        nested: [true, "tail", null],
    });
});

test("rewrite accepts any JSON replacement payload", async () => {
    const sequence = new ToolCallBoundarySequence({
        rewrites: [async () => [1, { ok: true }]],
    });

    assert.deepEqual(
        await sequence.rewrite({
            callId: "call-json",
            context,
            direction: "inbound",
            kind: "call",
            payload: { command: "echo ok" },
            signal: new AbortController().signal,
            toolName: "bash_run",
        }),
        [1, { ok: true }],
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

test("rewrite snapshots deeply nested whole payloads without recursive stack growth", async () => {
    const depth = 10_000;
    let payload: ToolCallReviewInput["payload"] = "leaf";
    for (let index = 0; index < depth; index += 1) payload = [payload];
    let seen: ToolCallReviewInput["payload"] | undefined;
    const sequence = new ToolCallBoundarySequence({
        rewrites: [async (rewriteInput) => {
            seen = rewriteInput.payload;
            return rewriteInput.payload;
        }],
    });

    let rewritten = await sequence.rewrite({
        callId: "call-deep",
        context,
        direction: "inbound",
        kind: "call",
        payload,
        signal: new AbortController().signal,
        toolName: "bash_run",
    });
    assert.notEqual(seen, payload);
    for (let index = 0; index < depth; index += 1) {
        assert.equal(Array.isArray(seen), true);
        assert.equal(Object.isFrozen(seen), true);
        seen = (seen as ToolCallReviewInput["payload"][])[0];
        assert.equal(Array.isArray(rewritten), true);
        rewritten = (rewritten as ToolCallReviewInput["payload"][])[0]!;
    }
    assert.equal(seen, "leaf");
    assert.equal(rewritten, "leaf");
});
