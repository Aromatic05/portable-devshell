import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    createError,
    errorCodes,
    type JsonValue,
} from "@portable-devshell/shared";

import { createToolCallScope } from "../../../src/toolcall/Context.ts";
import {
    ToolCallPipeline,
    type ToolCallTargetResolver,
} from "../../../src/toolcall/Pipeline.ts";
import { ToolCallHookSequence } from "../../../src/toolcall/hook/Sequence.ts";
import type {
    ToolCallReview,
    ToolCallHookValue,
} from "../../../src/toolcall/hook/Review.ts";
import type { ToolCallRewrite } from "../../../src/toolcall/hook/Rewrite.ts";

const context = {
    ctxId: "ctx-1",
    source: "mcp" as const,
    workspace: "/repo",
};

interface Harness {
    audit: string[];
    invoked: Array<{
        context: Record<string, unknown>;
        input: unknown;
        toolName: string;
    }>;
    pipeline: ToolCallPipeline;
    scheduled: Array<{
        callId: string;
        instanceName: string;
        toolName: string;
    }>;
}

function createHarness(
    instance: string,
    options: {
        reviews?: readonly ToolCallReview[];
        rewrites?: readonly ToolCallRewrite[];
        invoke?: (
            toolName: string,
            input: JsonValue,
            context: Record<string, unknown>,
            onProgress?: (progress: JsonValue) => void,
        ) => Promise<JsonValue>;
    } = {},
): Harness {
    const audit: string[] = [];
    const invoked: Harness["invoked"] = [];
    const scheduled: Harness["scheduled"] = [];
    const pipeline = new ToolCallPipeline({
        hooks: () => ({
            release() {},
            sequence: new ToolCallHookSequence({
                reviews: options.reviews,
                rewrites: options.rewrites,
            }),
        }),
        assertReady() {},
        audit: {
            createScope(
                callId: string,
                toolName: string,
                input: JsonValue,
                callContext: typeof context,
            ) {
                return createToolCallScope(
                    callId,
                    toolName,
                    input,
                    callContext,
                );
            },
            async requested() {
                audit.push("requested");
            },
            async queued() {
                audit.push("queued");
            },
            async denied() {
                audit.push("denied");
            },
            runningContext() {
                return {};
            },
            async running() {
                audit.push("running");
            },
            async completed() {
                audit.push("completed");
            },
            async failed() {
                audit.push("failed");
            },
            async failActive() {
                audit.push("failActive");
            },
            async nonRunning() {
                audit.push("nonRunning");
            },
        },
        instanceName: asInstanceName(instance),
        log: { async append() {} },
        toolCallScheduler: {
            reserve(request: Harness["scheduled"][number]) {
                scheduled.push(request);
                return {
                    release() {},
                    async run(operation: () => Promise<JsonValue>) {
                        return await operation();
                    },
                };
            },
        },
        toolInvoker: {
            async invoke(
                toolName: string,
                input: JsonValue,
                callContext: Record<string, unknown>,
                _signal?: AbortSignal,
                onProgress?: (progress: JsonValue) => void,
            ) {
                invoked.push({ context: callContext, input, toolName });
                return options.invoke === undefined
                    ? { ok: true }
                    : await options.invoke(
                          toolName,
                          input,
                          callContext,
                          onProgress,
                      );
            },
        },
    } as never);
    return { audit, invoked, pipeline, scheduled };
}

test("ToolCallPipeline rejects during review before rewrite and target resolution", async () => {
    const calls: string[] = [];
    const harness = createHarness("instance-a", {
        reviews: [
            async () => {
                calls.push("review");
                return { decision: "reject", reason: "blocked" };
            },
        ],
        rewrites: [
            async (input) => {
                calls.push("rewrite");
                return input.value;
            },
        ],
    });
    harness.pipeline.bindTargetResolver((() => {
        calls.push("resolve");
        return harness.pipeline;
    }) as ToolCallTargetResolver);

    await assert.rejects(
        harness.pipeline.call("bash_run", { command: "echo ok" }, context),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                errorCodes.coreToolCallRejected,
            );
            return true;
        },
    );

    assert.deepEqual(calls, ["review"]);
    assert.deepEqual(harness.audit, ["requested", "denied"]);
    assert.equal(harness.invoked.length, 0);
});

test("ToolCallPipeline resolves the rewritten instance and dispatches the rewritten value", async () => {
    const source = createHarness("instance-a", {
        rewrites: [
            async (input) =>
                input.direction === "inbound"
                    ? {
                          context: {
                              ...input.value.context,
                              ctxId: "ctx-b",
                              instance: asInstanceName("instance-b"),
                              workspace: "/b",
                          },
                          kind: "call",
                          payload: { path: "/b/file.txt" },
                          toolName: "file_read",
                      }
                    : input.value,
        ],
    });
    const target = createHarness("instance-b");
    const resolved: string[] = [];
    source.pipeline.bindTargetResolver((instance) => {
        resolved.push(instance);
        return target.pipeline;
    });
    const afterReview: Array<{ callId: string; instance: string }> = [];

    const result = await source.pipeline.call(
        "bash_run",
        { command: "echo original" },
        context,
        undefined,
        undefined,
        undefined,
        undefined,
        "host",
        (callId, instance) => {
            afterReview.push({ callId, instance });
        },
    );

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(resolved, ["instance-b"]);
    assert.equal(source.invoked.length, 0);
    assert.equal(target.invoked.length, 1);
    assert.deepEqual(target.invoked[0]?.input, { path: "/b/file.txt" });
    assert.equal(target.invoked[0]?.toolName, "file_read");
    assert.equal(target.invoked[0]?.context.ctxId, "ctx-b");
    assert.equal(target.invoked[0]?.context.workspace, "/b");
    assert.equal(typeof target.invoked[0]?.context.operationId, "string");
    assert.deepEqual(target.scheduled.map((entry) => entry.instanceName), [
        "instance-b",
    ]);
    assert.equal(afterReview[0]?.instance, "instance-b");
    assert.equal(afterReview[0]?.callId, target.scheduled[0]?.callId);
});

test("outbound progress and result run rewrite then review in forward order", async () => {
    const calls: string[] = [];
    const rewrite = (name: string): ToolCallRewrite => async (input) => {
        if (input.direction === "outbound") {
            calls.push(`rewrite:${input.value.kind}:${name}`);
            const payload = input.value.payload as Record<string, JsonValue>;
            return {
                ...input.value,
                payload: {
                    ...payload,
                    trace: [
                        ...(Array.isArray(payload.trace) ? payload.trace : []),
                        name,
                    ],
                },
            };
        }
        return input.value;
    };
    const review = (name: string): ToolCallReview => async (input) => {
        if (input.direction === "outbound")
            calls.push(`review:${input.value.kind}:${name}`);
        return { decision: "continue" };
    };
    const harness = createHarness("instance-a", {
        rewrites: [rewrite("100"), rewrite("900")],
        reviews: [review("100"), review("900")],
        async invoke(_toolName, _input, _context, onProgress) {
            onProgress?.({ step: 1 });
            return { ok: true };
        },
    });
    const progress: JsonValue[] = [];

    const result = await harness.pipeline.call(
        "bash_run",
        { command: "echo ok" },
        context,
        undefined,
        undefined,
        undefined,
        (value) => progress.push(value),
    );

    assert.deepEqual(progress, [{ step: 1, trace: ["100", "900"] }]);
    assert.deepEqual(result, { ok: true, trace: ["100", "900"] });
    assert.deepEqual(calls, [
        "rewrite:progress:100",
        "rewrite:progress:900",
        "review:progress:100",
        "review:progress:900",
        "rewrite:result:100",
        "rewrite:result:900",
        "review:result:100",
        "review:result:900",
    ]);
});

test("outbound error rewrite may replace error identity", async () => {
    const harness = createHarness("instance-a", {
        rewrites: [
            async (input) =>
                input.direction === "outbound" && input.value.kind === "error"
                    ? {
                          ...input.value,
                          payload: {
                              error: {
                                  code: "tool.rewritten",
                                  message: "rewritten",
                                  retryable: true,
                              },
                          },
                      }
                    : input.value,
        ],
        async invoke() {
            throw createError({
                code: "tool.original",
                message: "original",
                retryable: false,
            });
        },
    });

    await assert.rejects(
        harness.pipeline.call("bash_run", {}, context),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "tool.rewritten");
            assert.equal((error as Error).message, "rewritten");
            assert.equal(
                (error as { retryable?: boolean }).retryable,
                true,
            );
            return true;
        },
    );
});
