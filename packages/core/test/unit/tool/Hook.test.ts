import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    createToolCallRuntime,
    runtimeErrorCodes,
    type JsonValue,
    type ToolCallHookValue,
    type ToolCallReviewInput,
    type ToolCallReviewResult,
    type ToolCallRewriteInput,
} from "@portable-devshell/shared";

type Review = (
    input: ToolCallReviewInput,
) => ToolCallReviewResult | Promise<ToolCallReviewResult>;
type Rewrite = (
    input: ToolCallRewriteInput,
) => ToolCallHookValue | Promise<ToolCallHookValue>;

const context = {
    ctxId: "ctx-1",
    source: "mcp" as const,
    workspace: "/repo",
};

function registerHooks(
    runtime: ReturnType<typeof createToolCallRuntime>,
    reviews: readonly Review[] = [],
    rewrites: readonly Rewrite[] = [],
): void {
    reviews.forEach((review, index) => {
        runtime.hooks.registerReview({
            hook: "test-review",
            id: String(index).padStart(3, "0"),
            review: (input) => review(input),
        });
    });
    runtime.hooks.registerContributor(() => ({
        rewrites: rewrites.map((rewrite, index) => ({
            hook: "test-rewrite",
            id: String(index).padStart(3, "0"),
            rewrite: (input) => rewrite(input),
        })),
        release() {},
    }));
}

test("review receives one frozen value and stops at reject", async () => {
    const payload = { command: "echo ok", nested: { value: 1 } };
    const seen: Readonly<ToolCallHookValue>[] = [];
    const calls: string[] = [];
    const runtime = createToolCallRuntime({
        resolveTarget() {
            assert.fail("rejected calls must not resolve a target");
        },
    });
    registerHooks(runtime, [
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
    ]);

    await assert.rejects(
        runtime.api.call("instance-a", "bash_run", payload, context),
        { code: runtimeErrorCodes.toolCallRejected },
    );

    assert.deepEqual(calls, ["100", "500"]);
    assert.equal(seen[0], seen[1]);
    assert.notEqual(seen[0]?.payload, payload);
    assert.equal(Object.isFrozen(payload), false);
    runtime.close();
});

test("review and rewrite are independent pipelines", async () => {
    const calls: string[] = [];
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch(request) {
                return request.value.payload;
            },
        }),
    });
    registerHooks(
        runtime,
        [
            async () => {
                calls.push("review-100");
                return { decision: "continue" };
            },
            async () => {
                calls.push("review-900");
                return { decision: "continue" };
            },
        ],
        [
            async (rewrite) => {
                calls.push("rewrite-100");
                return rewrite.value;
            },
            async (rewrite) => {
                calls.push("rewrite-900");
                return rewrite.value;
            },
        ],
    );

    assert.deepEqual(
        await runtime.api.call("instance-a", "bash_run", { command: "echo ok" }, context),
        { command: "echo ok" },
    );
    assert.deepEqual(calls, [
        "review-100",
        "review-900",
        "rewrite-100",
        "rewrite-900",
    ]);
    runtime.close();
});

test("rewrite can replace the complete inbound call value", async () => {
    let dispatched: ToolCallHookValue | undefined;
    let resolvedInstance: string | undefined;
    const runtime = createToolCallRuntime({
        resolveTarget(instance) {
            resolvedInstance = instance;
            return {
                async dispatch(request) {
                    dispatched = request.value;
                    return { ok: true };
                },
            };
        },
    });
    registerHooks(runtime, [], [
        async (rewrite) => ({
            context: {
                ...rewrite.value.context,
                ctxId: "ctx-rewritten",
                instance: asInstanceName("instance-b"),
                workspace: "/rewritten",
            },
            kind: "call",
            payload: { rewritten: true },
            toolName: "file_read",
        }),
    ]);

    await runtime.api.call("instance-a", "bash_run", { command: "echo ok" }, context);

    assert.equal(resolvedInstance, "instance-b");
    assert.deepEqual(dispatched, {
        context: {
            ...context,
            instance: "instance-b",
            ctxId: "ctx-rewritten",
            workspace: "/rewritten",
        },
        kind: "call",
        payload: { rewritten: true },
        toolName: "file_read",
    });
    runtime.close();
});

test("rewrite order is forward for inbound and outbound", async () => {
    const calls: string[] = [];
    const rewrite =
        (name: string): Rewrite =>
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
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch(request) {
                const result = await request.hooks.rewrite({
                    callId: request.callId,
                    direction: "outbound",
                    value: { ...request.value, kind: "result", payload: [] },
                });
                return result.payload;
            },
        }),
    });
    registerHooks(runtime, [], [rewrite("100"), rewrite("900")]);

    const result = await runtime.api.call(
        "instance-a",
        "bash_run",
        [],
        context,
    );

    assert.deepEqual(result, ["100", "900"]);
    assert.deepEqual(calls, [
        "inbound:100",
        "inbound:900",
        "outbound:100",
        "outbound:900",
    ]);
    runtime.close();
});
