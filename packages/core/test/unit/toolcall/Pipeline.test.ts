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
    ToolCallExecutionTarget,
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
    target: ToolCallExecutionTarget;
    released: string[];
    scheduled: Array<{
        callId: string;
        instanceName: string;
        toolName: string;
    }>;
}

function createHarness(
    instance: string,
    options: {
        assertReady?: () => void;
        resolveTarget?: ToolCallTargetResolver;
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
    const target = new ToolCallExecutionTarget({
        assertReady() { options.assertReady?.(); },
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
    const released: string[] = [];
    const pipeline = new ToolCallPipeline({
        hooks: () => ({
            release() { released.push("release"); },
            sequence: new ToolCallHookSequence({
                reviews: options.reviews,
                rewrites: options.rewrites,
            }),
        }),
        resolveTarget: options.resolveTarget ?? (() => target),
    });
    return { audit, invoked, pipeline, target, scheduled, released };
}

test("ToolCallPipeline rejects during review before rewrite and target resolution", async () => {
    const calls: string[] = [];
    const harness = createHarness("instance-a", {
        resolveTarget: () => {
            calls.push("resolve");
            return harness.target;
        },
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


    await assert.rejects(
        harness.pipeline.call(asInstanceName("instance-a"), "bash_run", { command: "echo ok" }, context),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                errorCodes.coreToolCallRejected,
            );
            return true;
        },
    );

    assert.deepEqual(calls, ["review"]);
    assert.deepEqual(harness.audit, []);
    assert.deepEqual(harness.scheduled, []);
    assert.deepEqual(harness.released, ["release"]);
    assert.equal(harness.invoked.length, 0);
});

test("unknown original instance rewrites to a valid target resolved exactly once", async () => {
    const target = createHarness("instance-b");
    const resolved: string[] = [];
    const source = createHarness("instance-a", {
        resolveTarget: (instance) => {
            resolved.push(instance);
            assert.equal(instance, "instance-b");
            assert.deepEqual(source.released, []);
            return target.target;
        },
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
    const result = await source.pipeline.call(
        "unknown-instance",
        "bash_run",
        { command: "echo original" },
        context,
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
    assert.deepEqual(source.released, ["release"]);
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

    const result = await harness.pipeline.call(asInstanceName("instance-a"),
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
        harness.pipeline.call(asInstanceName("instance-a"), "bash_run", {}, context),
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

test("outbound result rewritten as error throws the rewritten body", async () => {
    const events: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [async (input) => {
            if (input.direction === "outbound") events.push(`rewrite:${input.value.kind}`);
            return input.direction === "outbound" && input.value.kind === "result"
                ? { ...input.value, kind: "error", payload: { error: {
                    code: "tool.rewritten", message: "rewritten", retryable: true,
                } } }
                : input.value;
        }],
        reviews: [async (input) => {
            if (input.direction === "outbound") events.push(`review:${input.value.kind}`);
            return { decision: "continue" };
        }],
    });
    await assert.rejects(harness.pipeline.call(asInstanceName("instance-a"), "bash_run", {}, context), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "tool.rewritten");
        assert.equal((error as Error).message, "rewritten");
        return true;
    });
    assert.deepEqual(events, ["rewrite:result", "review:error"]);
});

test("outbound error rewritten as result returns the rewritten payload", async () => {
    const reviewed: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [async (input) =>
            input.direction === "outbound" && input.value.kind === "error"
                ? { ...input.value, kind: "result", payload: { recovered: true } }
                : input.value],
        reviews: [async (input) => {
            if (input.direction === "outbound") reviewed.push(input.value.kind);
            return { decision: "continue" };
        }],
        async invoke() { throw new Error("original"); },
    });
    assert.deepEqual(await harness.pipeline.call(asInstanceName("instance-a"), "bash_run", {}, context), { recovered: true });
    assert.deepEqual(reviewed, ["result"]);
});

test("inbound rewrite to progress emits progress and returns it as terminal result", async () => {
    const events: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [async (input) => {
            events.push(`rewrite:${input.direction}:${input.value.kind}`);
            return input.direction === "inbound"
                ? { ...input.value, kind: "progress", payload: { stage: "rewritten" } }
                : input.value;
        }],
        reviews: [async (input) => {
            events.push(`review:${input.direction}:${input.value.kind}`);
            return { decision: "continue" };
        }],
    });
    const progress: JsonValue[] = [];
    assert.deepEqual(
        await harness.pipeline.call(asInstanceName("instance-a"), "bash_run", {}, context, undefined, undefined, undefined, (value) => progress.push(value)),
        { stage: "rewritten" },
    );
    assert.deepEqual(progress, [{ stage: "rewritten" }]);
    assert.equal(harness.invoked.length, 0);
    assert.deepEqual(events, ["review:inbound:call", "rewrite:inbound:call", "rewrite:outbound:progress", "review:outbound:progress"]);
});

test("outbound progress rewritten to result becomes the terminal override", async () => {
    const events: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [async (input) => {
            if (input.direction === "outbound") events.push(`rewrite:${input.value.kind}`);
            return input.direction === "outbound" && input.value.kind === "progress"
                ? { ...input.value, kind: "result", payload: { terminal: true } }
                : input.value;
        }],
        reviews: [async (input) => {
            if (input.direction === "outbound") events.push(`review:${input.value.kind}`);
            return { decision: "continue" };
        }],
        async invoke(_name, _input, _context, onProgress) {
            onProgress?.({ step: 1 });
            return { ordinary: true };
        },
    });
    const progress: JsonValue[] = [];
    assert.deepEqual(
        await harness.pipeline.call(asInstanceName("instance-a"), "bash_run", {}, context, undefined, undefined, undefined, (value) => progress.push(value)),
        { terminal: true },
    );
    assert.deepEqual(progress, []);
    assert.deepEqual(events, ["rewrite:progress", "review:result"]);
});


test("operation receives the final rewritten value while the ingress lease is held", async () => {
    const rewritten: ToolCallHookValue = {
        context: { ...context, instance: asInstanceName("instance-b"), ctxId: "ctx-b" },
        kind: "call",
        payload: { rewritten: true },
        toolName: "rewritten_operation",
    };
    const outbound: string[] = [];
    const harness = createHarness("instance-b", {
        rewrites: [({ direction, value }) => {
            if (direction === "inbound") return rewritten;
            outbound.push(value.kind);
            assert.deepEqual(harness.released, []);
            return value;
        }],
    });
    const result = await harness.pipeline.callOperation(
        "unknown-instance",
        "original_operation",
        {},
        context,
        async (callId, input, value) => {
            assert.equal(callId, harness.scheduled[0]?.callId);
            assert.deepEqual(input, rewritten.payload);
            assert.deepEqual(value, rewritten);
            assert.deepEqual(harness.released, []);
            await Promise.resolve();
            assert.deepEqual(harness.released, []);
            return { operated: true };
        },
    );
    assert.deepEqual(result, { operated: true });
    assert.deepEqual(outbound, ["result"]);
    assert.deepEqual(harness.invoked, []);
    assert.deepEqual(harness.audit, ["requested", "queued", "running", "completed"]);
    assert.deepEqual(harness.released, ["release"]);
});


test("invocationInput prepares the final rewritten call before reservation, readiness, and invocation", async () => {
    const order: string[] = [];
    const harness = createHarness("final", {
        assertReady: () => order.push("ready"),
        rewrites: [({ value, direction }) => direction === "inbound"
            ? { ...value, context: { ...value.context, instance: asInstanceName("final"), ctxId: "ctx-final" }, toolName: "rewritten", payload: { final: true } }
            : value],
        invoke: async () => { order.push("invoke"); return { ok: true }; },
    });
    await harness.pipeline.call("unknown", "original", {}, context, undefined, undefined,
        (input, callId, value) => {
            order.push("prepare");
            assert.deepEqual(harness.scheduled, []);
            assert.equal(typeof callId, "string");
            assert.equal(value.context.instance, "final");
            assert.equal(value.context.ctxId, "ctx-final");
            assert.equal(value.toolName, "rewritten");
            assert.deepEqual(value.payload, { final: true });
            assert.deepEqual(input, value.payload);
            return { adapted: true };
        },
    );
    assert.deepEqual(order, ["prepare", "ready", "invoke"]);
    assert.deepEqual(harness.invoked[0]?.input, { adapted: true });
});
