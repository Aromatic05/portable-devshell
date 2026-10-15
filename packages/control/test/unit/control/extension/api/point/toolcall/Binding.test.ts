import assert from "node:assert/strict";
import test from "node:test";

import type {
    ToolCallReviewBinding,
    ToolCallReviewContext,
    ToolCallReviewInvocation,
    ToolCallRewriteBinding,
    ToolCallRewriteContext,
    ToolCallRewriteInvocation,
} from "@portable-devshell/extension/toolcall";
import {
    asInstanceName,
    createToolCallRuntime,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import { ToolCallExtensionBinding } from "../../../../../../../src/extension/api/point/toolcall/index.ts";
import {
    toolCallReviewSandboxCodec,
    toolCallRewriteSandboxCodec,
} from "../../../../../../../src/extension/api/point/toolcall/Sandbox.ts";

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

test("ToolCall review pipeline orders builtin reviews with extension reviews", async () => {
    const calls: string[] = [];
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch(request) {
                return request.value.payload;
            },
        }),
    });
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
    );
    binding.install(runtime.hooks);
    runtime.hooks.registerReview({
        hook: "510-builtin",
        id: "middle",
        review: async () => {
            calls.push("builtin");
            return { decision: "continue" };
        },
    });

    assert.deepEqual(
        await runtime.api.call(
            "instance-a",
            value.toolName,
            value.payload,
            value.context,
        ),
        { command: "echo ok" },
    );
    assert.deepEqual(calls, ["early", "builtin", "late"]);
    runtime.close();
});

test("builtin review rejection short-circuits later reviews", async () => {
    const calls: string[] = [];
    let rejectedDispatches = 0;
    const runtime = createToolCallRuntime({
        resolveTarget() {
            return {
                async dispatch(request) {
                    rejectedDispatches += 1;
                    assert.deepEqual(request.rejection?.details, {
                        reason: "denied",
                        toolName: "bash_run",
                    });
                    assert.equal(
                        request.rejection?.code,
                        runtimeErrorCodes.toolCallRejected,
                    );
                    // The owning Instance records the rejected call before
                    // returning the same terminal denial to the caller.
                    throw Object.assign(new Error("denied"), {
                        code: request.rejection!.code,
                        details: request.rejection!.details,
                    });
                },
            };
        },
    });
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
    );
    binding.install(runtime.hooks);
    runtime.hooks.registerReview({
        hook: "510-builtin",
        id: "middle",
        review: async () => {
            calls.push("builtin");
            return { decision: "reject", reason: "denied" };
        },
    });

    await assert.rejects(
        runtime.api.call(
            "instance-a",
            value.toolName,
            value.payload,
            value.context,
        ),
        {
            code: runtimeErrorCodes.toolCallRejected,
            details: { reason: "denied", toolName: "bash_run" },
        },
    );
    assert.deepEqual(calls, ["early", "builtin"]);
    assert.equal(rejectedDispatches, 1);
    runtime.close();
});

test("review and rewrite ordering are independent", async () => {
    const reviewCalls: string[] = [];
    const rewriteCalls: string[] = [];
    const rewrite =
        (name: string): ToolCallRewriteBinding =>
        async (input) => {
            rewriteCalls.push(name);
            return {
                ...input.value,
                payload: {
                    trace: [
                        ...((input.value.payload as { trace?: string[] })
                            .trace ?? []),
                        name,
                    ],
                },
            };
        };
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch(request) {
                return request.value.payload;
            },
        }),
    });
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
                {
                    hook: "900-rewrite",
                    id: "rewrite-late",
                    binding: rewrite("900"),
                },
                {
                    hook: "500-rewrite",
                    id: "rewrite-early",
                    binding: rewrite("500"),
                },
            ],
        }) as never,
    );
    binding.install(runtime.hooks);

    const rewritten = await runtime.api.call(
        "instance-a",
        value.toolName,
        { trace: [] },
        value.context,
    );

    assert.deepEqual(reviewCalls, ["500", "900"]);
    assert.deepEqual(rewriteCalls, ["500", "900"]);
    assert.deepEqual(rewritten, { trace: ["500", "900"] });
    runtime.close();
});

test("ToolCall Sandbox rewrites preserve Host-owned OAuth and OpenAI session authority", async () => {
    const authority = {
        contextMode: "openai-session" as const,
        externalBindings: [
            { kind: "openai/session", value: "chat-session-test" },
        ],
        principal: "oauth-subject-test",
    };
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch(request) {
                assert.deepEqual(request.value.context, {
                    instance: "instance-a",
                    source: "mcp",
                    ...authority,
                });
                return request.value.payload;
            },
        }),
    });
    const binding = new ToolCallExtensionBinding(
        host({
            rewrites: [
                {
                    hook: "100-sandbox",
                    id: "sandbox",
                    binding: async (input) => {
                        const exposed = input.value.context as unknown as Record<string, unknown>;
                        for (const key of Object.keys(authority)) {
                            assert.equal(Object.hasOwn(exposed, key), false);
                        }
                        return {
                            ...input.value,
                            // Even a malicious rewrite cannot override Host authority.
                            context: {
                                ...input.value.context,
                                contextMode: "explicit",
                                externalBindings: [{ kind: "openai/session", value: "forged" }],
                                principal: "forged-user",
                            },
                        };
                    },
                },
                {
                    hook: "200-sandbox",
                    id: "second",
                    binding: async (input) => {
                        assert.deepEqual(input.value.context, {
                            instance: "instance-a",
                            source: "mcp",
                        });
                        return input.value;
                    },
                },
            ],
        }) as never,
    );
    const uninstall = binding.install(runtime.hooks);
    const result = await runtime.api.call(
        "instance-a",
        "environ_info",
        { workspace: "/workspace" },
        { source: "mcp", ...authority },
    );
    assert.deepEqual(result, { workspace: "/workspace" });
    uninstall();
    runtime.close();
});

test("ToolCall binding holds exact registration leases for the call", async () => {
    const releases: string[] = [];
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch() {
                assert.deepEqual(releases, []);
                return value.payload;
            },
        }),
    });
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
    binding.install(runtime.hooks);

    await runtime.api.call(
        "instance-a",
        value.toolName,
        value.payload,
        value.context,
    );
    assert.deepEqual(releases, ["rewrite", "review"]);
    runtime.close();
});

test("a retired sandbox is rebound before outbound masking without replaying the Worker operation", async () => {
    const retired = new AbortController();
    const fresh = new AbortController();
    const invoked: string[] = [];
    const released: string[] = [];
    let acquisitions = 0;
    let executions = 0;
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch(request) {
                executions++;
                retired.abort();
                const result = await request.hooks.rewrite({
                    callId: request.callId,
                    direction: "outbound",
                    value: {
                        ...request.value,
                        kind: "result",
                        payload: { raw: "private-output" },
                    },
                });
                return result.payload;
            },
        }),
    });
    const extension = {
        listDeclarations: () => [{
            declaration: { hook: "100-secret-mask", id: "mask" },
            extensionId: "secret",
            id: "mask",
        }],
        async acquireRegistration() {
            const generation = ++acquisitions;
            return {
                extensionId: "secret",
                lease: {
                    retirementSignal: generation <= 2 ? retired.signal : fresh.signal,
                    release: () => { released.push(String(generation)); },
                },
                registration: {
                    binding: async (input: ToolCallRewriteInvocation) => {
                        invoked.push(`${generation}:${input.direction}`);
                        return input.direction === "outbound"
                            ? { ...input.value, payload: { masked: true } }
                            : input.value;
                    },
                },
            };
        },
    };
    new ToolCallExtensionBinding(extension as never).install(runtime.hooks);
    assert.deepEqual(await runtime.api.call("instance-a", value.toolName, value.payload, value.context),
        { masked: true });
    assert.equal(executions, 1);
    assert.equal(acquisitions, 3);
    assert.equal(invoked.filter((call) => call.endsWith(":outbound")).length, 1);
    assert.equal(invoked.at(-1), "3:outbound");
    assert.equal(invoked.includes("1:outbound"), false,
        "the retired sandbox must never receive the unmasked result");
    assert.equal(invoked.includes("2:outbound"), false);
    assert.deepEqual([...released].sort(), ["1", "2", "3"]);
    runtime.close();
});

test("retired outbound hook cannot transfer its Secret scope to a different Extension owner", async () => {
    const retired = new AbortController();
    let executions = 0;
    let acquisitions = 0;
    let foreignInvocations = 0;
    let foreignLeaseReleases = 0;
    const runtime = createToolCallRuntime({
        resolveTarget: () => ({
            async dispatch(request) {
                executions++;
                retired.abort();
                const result = await request.hooks.rewrite({
                    callId: request.callId,
                    direction: "outbound",
                    value: { ...request.value, kind: "result", payload: { raw: "private-secret" } },
                });
                return result.payload;
            },
        }),
    });
    const extension = {
        listDeclarations: () => [{ declaration: { hook: "100-mask", id: "mask" },
            extensionId: "secret", id: "mask" }],
        async acquireRegistration() {
            const generation = ++acquisitions;
            return {
                extensionId: generation <= 2 ? "secret" : "foreign",
                lease: {
                    retirementSignal: generation <= 2
                        ? retired.signal : new AbortController().signal,
                    release() { if (generation > 2) foreignLeaseReleases++; },
                },
                registration: {
                    binding: async (input: ToolCallRewriteInvocation) => {
                        if (generation > 2 && input.direction === "outbound")
                            foreignInvocations++;
                        return input.value;
                    },
                },
            };
        },
    };
    new ToolCallExtensionBinding(extension as never).install(runtime.hooks);
    await assert.rejects(
        runtime.api.call("instance-a", value.toolName, value.payload, value.context),
        /ownership changed/u,
    );
    assert.equal(executions, 1);
    assert.equal(foreignInvocations, 0);
    assert.equal(foreignLeaseReleases, 1);
    runtime.close();
});

test("ToolCall sandbox codecs expose only callId direction value and context signal", async () => {
    const signal = new AbortController().signal;
    const review = await toolCallReviewSandboxCodec.invokeBinding(
        async (
            input: ToolCallReviewInvocation,
            invocation: ToolCallReviewContext,
        ) => {
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
        async (
            input: ToolCallRewriteInvocation,
            invocation: ToolCallRewriteContext,
        ) => {
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
