import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    createRemoteError,
    createToolCallRuntime,
    runtimeErrorCodes,
    type JsonValue,
    type ToolCallHookValue,
    type ToolCallReviewInput,
    type ToolCallReviewResult,
    type ToolCallRewriteInput,
    type ToolCallTargetResolver,
} from "@portable-devshell/shared";

import { createToolCallScope } from "../../../src/toolcall/execution/Context.ts";
import { ToolCallExecutionTarget } from "../../../src/toolcall/execution/ExecutionTarget.ts";
import { GoalState, GOAL_EXECUTION_LEASE_MS } from "../../../src/task/goal/storage/State.ts";

type ToolCallReview = (
    input: ToolCallReviewInput,
) => ToolCallReviewResult | Promise<ToolCallReviewResult>;
type ToolCallRewrite = (
    input: ToolCallRewriteInput,
) => ToolCallHookValue | Promise<ToolCallHookValue>;

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
    runtime: ReturnType<typeof createToolCallRuntime>;
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
        failCompletedAudit?: boolean;
        failFailedAudit?: boolean;
        failQueuedAudit?: boolean;
        onExecutionActivity?: (ctxId: string, kind: "execution" | "mutation") => Promise<void>;
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
        assertReady() {
            options.assertReady?.();
        },
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
                if (options.failQueuedAudit) throw new Error("queued audit unavailable");
            },
            runningContext() {
                return {};
            },
            async running() {
                audit.push("running");
            },
            async completed() {
                audit.push("completed");
                if (options.failCompletedAudit) throw new Error("audit storage unavailable");
            },
            abandon() {
                audit.push("abandon");
            },
            async failed() {
                audit.push("failed");
                if (options.failFailedAudit) throw new Error("failed audit unavailable");
            },
            async denied() {
                audit.push("denied");
            },
            async failActive() {
                audit.push("failActive");
            },
            async nonRunning() {
                audit.push("nonRunning");
            },
        },
        instanceName: asInstanceName(instance),
        onExecutionActivity: options.onExecutionActivity,
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
    const runtime = createToolCallRuntime({
        resolveTarget: options.resolveTarget ?? (() => target),
    });
    options.reviews?.forEach((review, index) => {
        runtime.hooks.registerReview({
            hook: "test-review",
            id: String(index).padStart(3, "0"),
            review: (input) => review(input),
        });
    });
    runtime.hooks.registerContributor(() => ({
        rewrites: (options.rewrites ?? []).map((rewrite, index) => ({
            hook: "test-rewrite",
            id: String(index).padStart(3, "0"),
            rewrite: (input) => rewrite(input),
        })),
        release() {
            released.push("release");
        },
    }));
    return { audit, invoked, runtime, target, scheduled, released };
}

test("a successfully executed tool returns its result when completion audit fails", async () => {
    const harness = createHarness("instance-a", { failCompletedAudit: true });
    const warning = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        const result = await harness.runtime.api.call(
            asInstanceName("instance-a"), "file_edit", { changes: "test" }, context,
        );
        assert.deepEqual(result, { ok: true });
        assert.equal(harness.invoked.length, 1, "execution must never be repeated");
        assert.deepEqual(harness.audit, ["requested", "queued", "running", "completed", "abandon"]);
        assert.equal(warnings.length, 1);
    } finally {
        console.warn = warning;
    }
});

test("queue audit errors cannot prevent a tool from executing", async (t) => {
    const warning = t.mock.method(console, "warn", () => undefined);
    const harness = createHarness("instance-a", { failQueuedAudit: true });
    assert.deepEqual(await harness.runtime.api.call(
        asInstanceName("instance-a"), "bash_run", { command: "echo ok" }, context,
    ), { ok: true });
    assert.equal(harness.invoked.length, 1);
    assert.deepEqual(harness.audit, ["requested", "queued", "abandon", "running", "completed"]);
    assert.equal(warning.mock.callCount(), 1);
});

test("failed tool retains its error even if failure audit cannot be persisted", async (t) => {
    const warning = t.mock.method(console, "warn", () => undefined);
    const harness = createHarness("instance-a", {
        failFailedAudit: true,
        invoke: async () => { throw new Error("tool execution failed"); },
    });
    await assert.rejects(harness.runtime.api.call(
        asInstanceName("instance-a"), "file_edit", { changes: "test" }, context,
    ), /tool execution failed/u);
    assert.equal(harness.invoked.length, 1);
    assert.ok(harness.audit.includes("abandon"));
    assert.equal(warning.mock.callCount(), 1);
});

test("a post-execution outbound failure reports executionCompleted to the caller", async () => {
    let resultHookCalls = 0;
    let errorHookCalls = 0;
    const harness = createHarness("instance-a", {
        rewrites: [async (input) => {
            if (input.direction === "outbound") {
                if (input.value.kind === "error") errorHookCalls++;
                if (input.value.kind === "result") resultHookCalls++;
                throw new Error("outbound hook-private-secret");
            }
            return input.value;
        }],
        invoke: async () => ({ output: "raw-tool-private-secret" }),
    });
    await assert.rejects(harness.runtime.api.call(
        asInstanceName("instance-a"), "file_edit", { changes: "test" }, context,
    ), (error: unknown) => {
        const failure = error as { code?: string; message?: string; details?: {
            callId?: string; executionCompleted?: boolean; failureStage?: string;
        } };
        const details = failure.details;
        assert.equal(failure.code, runtimeErrorCodes.toolResultDeliveryFailed);
        assert.match(failure.message ?? "", /execution completed.*could not be delivered safely/iu);
        assert.equal(details?.executionCompleted, true);
        assert.equal(details?.failureStage, "outboundHook");
        assert.ok(details?.callId);
        assert.ok(!JSON.stringify(failure).includes("private-secret"),
            "unmasked tool result and hook error must never leak into the failure");
        return true;
    });
    assert.equal(harness.invoked.length, 1);
    assert.equal(resultHookCalls, 1);
    assert.equal(errorHookCalls, 0, "failed result rewrite must not re-enter the same broken hook");
});

test("outbound error rewrite failure preserves original error identity in private diagnostics", async (t) => {
    const warning = t.mock.method(console, "warn", () => undefined);
    const harness = createHarness("instance-a", {
        rewrites: [async (input) => {
            if (input.direction === "outbound" && input.value.kind === "error")
                throw new Error("hook-private-secret");
            return input.value;
        }],
        invoke: async () => {
            throw createRemoteError({
                code: "tool.executionFailed",
                message: "tool-private-secret",
                retryable: false,
            });
        },
    });
    await assert.rejects(harness.runtime.api.call(
        asInstanceName("instance-a"), "bash_run", { command: "tool-input-secret" }, context,
    ), (error: unknown) => {
        assert.equal((error as { code?: string }).code, runtimeErrorCodes.providerFailed);
        const details = (error as { details?: { executionCompleted?: boolean; failureStage?: string } }).details;
        assert.equal(details?.executionCompleted, false);
        assert.equal(details?.failureStage, "outboundHook");
        return true;
    });
    const diagnostics = warning.mock.calls.find((call) =>
        call.arguments[0] === "ToolCall outbound hook failed");
    assert.ok(diagnostics);
    const data = diagnostics.arguments[1] as Record<string, unknown>;
    assert.equal(data.phase, "error");
    assert.equal(data.originalCode, "tool.executionFailed");
    assert.equal(data.causeCode, "error.unknown");
    assert.equal(data.toolName, "bash_run");
    assert.ok(!JSON.stringify(data).includes("-secret"));
    assert.equal(harness.invoked.length, 1);
});

test("ToolCallPipeline audits review rejection in Instance without rewrite or execution", async () => {
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
        harness.runtime.api.call(
            asInstanceName("instance-a"),
            "bash_run",
            { command: "echo ok" },
            context,
        ),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                runtimeErrorCodes.toolCallRejected,
            );
            return true;
        },
    );

    assert.deepEqual(calls, ["review", "resolve"]);
    assert.deepEqual(harness.audit, ["requested", "denied"]);
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
    const result = await source.runtime.api.call(
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
    assert.deepEqual(
        target.scheduled.map((entry) => entry.instanceName),
        ["instance-b"],
    );
    assert.deepEqual(source.released, ["release"]);
});

test("registered execute handles the rewritten tool through the target lifecycle", async () => {
    const target = createHarness("instance-a", {
        assertReady() {
            assert.fail("registered execute must not require worker readiness");
        },
        rewrites: [
            async (input) =>
                input.direction === "inbound"
                    ? {
                          ...input.value,
                          payload: { value: 2 },
                          toolName: "virtual_execute",
                      }
                    : input.value,
        ],
    });
    const executed: Array<{ input: JsonValue; toolName: string }> = [];
    target.runtime.hooks.registerExecute(
        "virtual_execute",
        async (_callId, input, value) => {
            executed.push({ input, toolName: value.toolName });
            return { handled: true };
        },
    );

    const result = await target.runtime.api.call(
        "instance-a",
        "bash_run",
        { command: "echo original" },
        context,
    );

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(executed, [
        { input: { value: 2 }, toolName: "virtual_execute" },
    ]);
    assert.deepEqual(target.invoked, []);
    assert.deepEqual(
        target.scheduled.map((entry) => entry.toolName),
        ["virtual_execute"],
    );
    assert.deepEqual(target.audit, [
        "requested",
        "queued",
        "running",
        "completed",
    ]);
});

test("outbound progress and result run rewrite then review in forward order", async () => {
    const calls: string[] = [];
    const rewrite =
        (name: string): ToolCallRewrite =>
        async (input) => {
            if (input.direction === "outbound") {
                calls.push(`rewrite:${input.value.kind}:${name}`);
                const payload = input.value.payload as Record<
                    string,
                    JsonValue
                >;
                return {
                    ...input.value,
                    payload: {
                        ...payload,
                        trace: [
                            ...(Array.isArray(payload.trace)
                                ? payload.trace
                                : []),
                            name,
                        ],
                    },
                };
            }
            return input.value;
        };
    const review =
        (name: string): ToolCallReview =>
        async (input) => {
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

    const result = await harness.runtime.api.call(
        asInstanceName("instance-a"),
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
            throw createRemoteError({
                code: "tool.original",
                message: "original",
                retryable: false,
            });
        },
    });

    await assert.rejects(
        harness.runtime.api.call(
            asInstanceName("instance-a"),
            "bash_run",
            {},
            context,
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "tool.rewritten");
            assert.equal((error as Error).message, "rewritten");
            assert.equal((error as { retryable?: boolean }).retryable, true);
            return true;
        },
    );
});

test("outbound result rewritten as error throws the rewritten body", async () => {
    const events: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [
            async (input) => {
                if (input.direction === "outbound")
                    events.push(`rewrite:${input.value.kind}`);
                return input.direction === "outbound" &&
                    input.value.kind === "result"
                    ? {
                          ...input.value,
                          kind: "error",
                          payload: {
                              error: {
                                  code: "tool.rewritten",
                                  message: "rewritten",
                                  retryable: true,
                              },
                          },
                      }
                    : input.value;
            },
        ],
        reviews: [
            async (input) => {
                if (input.direction === "outbound")
                    events.push(`review:${input.value.kind}`);
                return { decision: "continue" };
            },
        ],
    });
    await assert.rejects(
        harness.runtime.api.call(
            asInstanceName("instance-a"),
            "bash_run",
            {},
            context,
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "tool.rewritten");
            assert.equal((error as Error).message, "rewritten");
            return true;
        },
    );
    assert.deepEqual(events, ["rewrite:result", "review:error"]);
});

test("outbound error rewritten as result returns the rewritten payload", async () => {
    const reviewed: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [
            async (input) =>
                input.direction === "outbound" && input.value.kind === "error"
                    ? {
                          ...input.value,
                          kind: "result",
                          payload: { recovered: true },
                      }
                    : input.value,
        ],
        reviews: [
            async (input) => {
                if (input.direction === "outbound")
                    reviewed.push(input.value.kind);
                return { decision: "continue" };
            },
        ],
        async invoke() {
            throw new Error("original");
        },
    });
    assert.deepEqual(
        await harness.runtime.api.call(
            asInstanceName("instance-a"),
            "bash_run",
            {},
            context,
        ),
        { recovered: true },
    );
    assert.deepEqual(reviewed, ["result"]);
});

test("inbound rewrite to progress emits progress and returns it as terminal result", async () => {
    const events: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [
            async (input) => {
                events.push(`rewrite:${input.direction}:${input.value.kind}`);
                return input.direction === "inbound"
                    ? {
                          ...input.value,
                          kind: "progress",
                          payload: { stage: "rewritten" },
                      }
                    : input.value;
            },
        ],
        reviews: [
            async (input) => {
                events.push(`review:${input.direction}:${input.value.kind}`);
                return { decision: "continue" };
            },
        ],
    });
    const progress: JsonValue[] = [];
    assert.deepEqual(
        await harness.runtime.api.call(
            asInstanceName("instance-a"),
            "bash_run",
            {},
            context,
            undefined,
            undefined,
            undefined,
            (value) => progress.push(value),
        ),
        { stage: "rewritten" },
    );
    assert.deepEqual(progress, [{ stage: "rewritten" }]);
    assert.equal(harness.invoked.length, 0);
    assert.deepEqual(events, [
        "review:inbound:call",
        "rewrite:inbound:call",
        "rewrite:outbound:progress",
        "review:outbound:progress",
    ]);
});

test("outbound progress rewritten to result becomes the terminal override", async () => {
    const events: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [
            async (input) => {
                if (input.direction === "outbound")
                    events.push(`rewrite:${input.value.kind}`);
                return input.direction === "outbound" &&
                    input.value.kind === "progress"
                    ? {
                          ...input.value,
                          kind: "result",
                          payload: { terminal: true },
                      }
                    : input.value;
            },
        ],
        reviews: [
            async (input) => {
                if (input.direction === "outbound")
                    events.push(`review:${input.value.kind}`);
                return { decision: "continue" };
            },
        ],
        async invoke(_name, _input, _context, onProgress) {
            onProgress?.({ step: 1 });
            return { ordinary: true };
        },
    });
    const progress: JsonValue[] = [];
    assert.deepEqual(
        await harness.runtime.api.call(
            asInstanceName("instance-a"),
            "bash_run",
            {},
            context,
            undefined,
            undefined,
            undefined,
            (value) => progress.push(value),
        ),
        { terminal: true },
    );
    assert.deepEqual(progress, []);
    assert.deepEqual(events, ["rewrite:progress", "review:result"]);
});

test("invocationInput prepares the final rewritten call before reservation, readiness, and invocation", async () => {
    const order: string[] = [];
    const harness = createHarness("final", {
        assertReady: () => order.push("ready"),
        rewrites: [
            ({ value, direction }) =>
                direction === "inbound"
                    ? {
                          ...value,
                          context: {
                              ...value.context,
                              instance: asInstanceName("final"),
                              ctxId: "ctx-final",
                          },
                          toolName: "rewritten",
                          payload: { final: true },
                      }
                    : value,
        ],
        invoke: async () => {
            order.push("invoke");
            return { ok: true };
        },
    });
    await harness.runtime.api.call(
        "unknown",
        "original",
        {},
        context,
        undefined,
        undefined,
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

test("review denial is isolated from a later Context call through rewrite, execution, and audit", async () => {
    const reviewed: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [async (input) => input.direction === "outbound"
            ? { ...input.value, payload: { safe: true } }
            : input.value],
        reviews: [async (input) => {
            reviewed.push(`${input.direction}:${input.value.context.ctxId}`);
            if (input.direction === "inbound" && input.value.context.ctxId === "ctx-1")
                return { decision: "reject", reason: "execution blocked" };
            if (input.direction === "outbound") {
                assert.deepEqual(input.value.payload, { safe: true });
            }
            return { decision: "continue" };
        }],
    });
    await assert.rejects(harness.runtime.api.call(
        "instance-a", "file_edit", {}, context,
    ), (error: unknown) => {
        assert.equal((error as { code?: string }).code, runtimeErrorCodes.toolCallRejected);
        return true;
    });
    assert.equal(harness.invoked.length, 0);
    assert.deepEqual(harness.scheduled, []);
    assert.deepEqual(harness.audit, ["requested", "denied"]);
    assert.deepEqual(await harness.runtime.api.call(
        "instance-a", "file_edit", {}, { ...context, ctxId: "ctx-2" },
    ), { safe: true });
    assert.deepEqual(harness.invoked.map(({ context: value }) => value.ctxId), ["ctx-2"]);
    assert.deepEqual(reviewed, ["inbound:ctx-1", "inbound:ctx-2", "outbound:ctx-2"]);
    assert.deepEqual(harness.audit, ["requested", "denied", "requested", "queued", "running", "completed"]);
    assert.deepEqual(harness.released, ["release", "release"]);
});

test("an outbound rewrite that turns a result into an error audits completed execution once", async () => {
    const harness = createHarness("instance-a", {
        rewrites: [async (input) => input.direction === "outbound" && input.value.kind === "result"
            ? {
                  ...input.value,
                  kind: "error",
                  payload: { error: { code: "tool.rewritten", message: "withheld", retryable: false } },
              }
            : input.value],
    });

    await assert.rejects(harness.runtime.api.call(
        "instance-a", "file_edit", {}, context,
    ), { code: "tool.rewritten" });

    assert.equal(harness.invoked.length, 1);
    assert.deepEqual(harness.audit, ["requested", "queued", "running", "failed"]);
});

test("a failed Context rewrite does not poison a later Context call", async () => {
    const rewrites: string[] = [];
    const harness = createHarness("instance-a", {
        rewrites: [async (input) => {
            if (input.direction === "inbound") {
                const ctxId = input.value.context.ctxId;
                rewrites.push(`in:${ctxId}`);
                if (ctxId === "ctx-1") throw new Error("rewrite unavailable");
            }
            return input.value;
        }],
    });

    await assert.rejects(harness.runtime.api.call("instance-a", "file_edit", {}, context), /rewrite unavailable/u);
    assert.deepEqual(await harness.runtime.api.call(
        "instance-a", "file_edit", {}, { ...context, ctxId: "ctx-2" },
    ), { ok: true });
    assert.deepEqual(rewrites, ["in:ctx-1", "in:ctx-2"]);
    assert.equal(harness.invoked.length, 1);
    assert.equal(harness.invoked[0]?.context.ctxId, "ctx-2");
});


test("running ToolCalls keep a Context Goal lease fresh until real execution ends", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let now = Date.parse("2026-10-23T00:00:00.000Z");
    const state = new GoalState({
        now: () => new Date(now).toISOString(),
        goalId: () => "goal-long-running",
    });
    let document = state.manage(state.emptyDocument(), {
        action: "start", objective: "Complete the long operation",
    }, context.ctxId).document;
    const activity: string[] = [];
    let complete!: (value: JsonValue) => void;
    const harness = createHarness("instance-a", {
        onExecutionActivity: async (ctxId) => {
            activity.push(ctxId);
            document = state.touch(document, ctxId, "execution").document;
        },
        invoke: async () => await new Promise<JsonValue>((resolve) => {
            complete = resolve;
        }),
    });
    const running = harness.runtime.api.call("instance-a", "bash_run", {
        command: "long running operation",
    }, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(activity.length, 1);
    assert.equal(state.read(document, context.ctxId)?.continuationDue, false);

    for (let pulse = 0; pulse < 4; pulse++) {
        now += 20_000;
        t.mock.timers.tick(20_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(state.read(document, context.ctxId)?.continuationDue, false);
    }
    assert.equal(activity.length, 5);
    complete({ ok: true });
    await running;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(activity.length, 6, "one final activity pulse after the call completes");
    assert.equal(state.read(document, context.ctxId)?.continuationDue, false);
    now += GOAL_EXECUTION_LEASE_MS + 1;
    assert.equal(state.read(document, context.ctxId)?.continuationDue, true);
    t.mock.timers.tick(20_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(activity.length, 6, "ToolCall heartbeat stops when execution ends");
    harness.runtime.close();
});

test("Goal control and extension-owned ToolCalls do not fabricate execution activity", async () => {
    const activity: string[] = [];
    const harness = createHarness("instance-a", {
        onExecutionActivity: async (ctxId) => { activity.push(ctxId); },
    });
    for (const toolName of ["workspace_goal", "mcpapp_open", "mcpapp_reentry", "progress_report"]) {
        await harness.runtime.api.call("instance-a", toolName, {}, context);
    }
    await harness.runtime.api.call("instance-a", "file_read", {}, {
        ...context, source: "extension",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(activity, []);
    harness.runtime.close();
});


test("only applied file edits, not reads or failed edits, advance durable Goal progress", async () => {
    const evidence: Array<{ ctxId: string; kind: string }> = [];
    const harness = createHarness("instance-a", {
        onExecutionActivity: async (ctxId, kind) => {
            evidence.push({ ctxId, kind });
        },
        invoke: async (toolName, input): Promise<JsonValue> => {
            if (toolName === "file_edit") return {
                operations: [{ status: (input as { applied?: boolean }).applied ? "applied" : "rejected" }],
            };
            return { ok: true };
        },
    });
    await harness.runtime.api.call("instance-a", "file_read", {}, context);
    await harness.runtime.api.call("instance-a", "file_edit", { applied: false }, context);
    await harness.runtime.api.call("instance-a", "file_edit", { applied: true }, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(evidence.map((entry) => entry.kind), [
        "execution", "execution", "execution", "execution", "execution", "mutation",
    ]);
    assert.ok(evidence.every((entry) => entry.ctxId === context.ctxId));
    harness.runtime.close();
});

test("an applied file edit does not finish before its final Goal progress is persisted", async () => {
    let started!: () => void;
    let release!: () => void;
    const mutationStarted = new Promise<void>((resolve) => { started = resolve; });
    const persistMutation = new Promise<void>((resolve) => { release = resolve; });
    let durable = false;
    const harness = createHarness("instance-a", {
        onExecutionActivity: async (_ctxId, kind) => {
            if (kind !== "mutation") return;
            started();
            await persistMutation;
            durable = true;
        },
        invoke: async () => ({ operations: [{ status: "applied" }] }),
    });
    const running = harness.runtime.api.call("instance-a", "file_edit", {}, context);
    await mutationStarted;
    let returned = false;
    void running.then(() => { returned = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(returned, false, "ToolCall must still await the final progress commit");
    release();
    assert.deepEqual(await running, { operations: [{ status: "applied" }] });
    assert.equal(durable, true);
    harness.runtime.close();
});

test("applied file edit with a failed Goal commit exposes its result and forbids replay", async () => {
    const result = { operations: [{ status: "applied", path: "changed.txt" }] };
    let executions = 0;
    const harness = createHarness("instance-a", {
        onExecutionActivity: async (_ctxId, kind) => {
            if (kind === "mutation") throw new Error("injected Goal EIO");
        },
        invoke: async () => {
            executions += 1;
            return result;
        },
    });
    await assert.rejects(
        harness.runtime.api.call("instance-a", "file_edit", {}, context),
        (error: unknown) => {
            const body = error as {
                code?: string;
                retryable?: boolean;
                details?: { executionCompleted?: boolean; failureStage?: string; result?: JsonValue };
            };
            assert.equal(body.code, "goal.activityCommitFailed");
            assert.equal(body.retryable, false);
            assert.equal(body.details?.executionCompleted, true);
            assert.equal(body.details?.failureStage, "postExecution");
            assert.deepEqual(body.details?.result, result);
            return true;
        },
    );
    assert.equal(executions, 1, "a completed file edit must never be automatically replayed");
    assert.deepEqual(harness.audit, ["requested", "queued", "running", "failed"]);
    harness.runtime.close();
});
