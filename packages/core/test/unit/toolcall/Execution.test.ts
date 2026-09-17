import assert from "node:assert/strict";
import test from "node:test";

import { createError, errorCodes, asInstanceName } from "@portable-devshell/shared";

import { ToolCallExecution } from "../../../src/toolcall/Execution.ts";
import { createToolCallScope } from "../../../src/toolcall/Context.ts";
import { ToolCallBoundarySequence } from "../../../src/toolcall/boundary/Sequence.ts";

const context = Object.freeze({
    ctxId: "ctx-boundary",
    source: "mcp" as const,
    workspace: "/repo",
});

function createHarness(decision: "accept" | "approve" | "reject") {
    const events: string[] = [];
    const approvalInputs: unknown[] = [];
    const denied: string[] = [];
    let invokes = 0;
    let releases = 0;
    const execution = new ToolCallExecution({
        approval: {
            async prepare(input: unknown) {
                events.push("approval");
                approvalInputs.push(input);
                return {};
            },
        },
        assertReady() {
            events.push("ready");
        },
        audit: {
            createScope(toolName: string, input: unknown, callContext: typeof context) {
                return createToolCallScope(toolName, input as never, callContext);
            },
            async requested() {
                events.push("audit.requested");
            },
            async queued() {
                events.push("audit.queued");
            },
            async denied(_scope: unknown, errorCode: string) {
                events.push("audit.denied");
                denied.push(errorCode);
            },
            runningContext() {
                return {};
            },
            async running() {
                events.push("audit.running");
            },
            async completed() {
                events.push("audit.completed");
            },
            async failed() {
                events.push("audit.failed");
            },
            async failActive() {
                events.push("audit.failActive");
            },
            async nonRunning() {
                events.push("audit.nonRunning");
            },
        },
        boundary: () => ({
            release() { releases += 1; },
            sequence: new ToolCallBoundarySequence({
                reviews: [async () => {
                    events.push("review");
                    return { decision };
                }],
            }),
        }),
        instanceName: asInstanceName("boundary-test"),
        log: { async append() {} },
        toolCallScheduler: {
            reserve() {
                events.push("reserve");
                return {
                    markPendingApproval() {
                        events.push("pendingApproval");
                    },
                    release() {
                        events.push("release");
                    },
                    async run(operation: () => Promise<unknown>) {
                        events.push("run");
                        return await operation();
                    },
                };
            },
        },
        toolInvoker: {
            async invoke() {
                invokes += 1;
                events.push("invoke");
                return { ok: true };
            },
        },
    } as never);
    return {
        approvalInputs,
        denied,
        events,
        execution,
        invokes: () => invokes,
        releases: () => releases,
    };
}

test("ToolCallExecution reviews the canonical outer call before scheduler admission", async () => {
    const harness = createHarness("reject");

    await assert.rejects(
        harness.execution.call("bash_run", { command: "echo ok" }, context),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                errorCodes.coreToolCallRejected,
            );
            return true;
        },
    );
    assert.deepEqual(harness.events, [
        "ready",
        "audit.requested",
        "review",
        "audit.denied",
    ]);
    assert.deepEqual(harness.denied, [errorCodes.coreToolCallRejected]);
    assert.equal(harness.invokes(), 0);
    assert.equal(harness.releases(), 1);
});

test("ToolCallExecution turns review approve into required Core Approval", async () => {
    const harness = createHarness("approve");

    assert.deepEqual(
        await harness.execution.call("bash_run", { command: "echo ok" }, context),
        { ok: true },
    );
    assert.equal(
        (harness.approvalInputs[0] as { required?: boolean }).required,
        true,
    );
    assert.deepEqual(harness.events.slice(0, 6), [
        "ready",
        "audit.requested",
        "review",
        "reserve",
        "audit.queued",
        "approval",
    ]);
});

test("ToolCallExecution leaves approval optional when every reviewer accepts", async () => {
    const harness = createHarness("accept");

    await harness.execution.call("bash_run", { command: "echo ok" }, context);
    assert.equal(
        (harness.approvalInputs[0] as { required?: boolean }).required,
        false,
    );
});

test("ToolCallExecution rewrites only at the trusted execution edge and exposes only outer result/progress", async () => {
    const events: string[] = [];
    const invoked: unknown[] = [];
    const completed: unknown[] = [];
    const progress: unknown[] = [];
    const reviewed: Array<{ direction: string; kind: string; payload: unknown }> = [];
    const execution = new ToolCallExecution({
        approval: { async prepare() { return {}; } },
        assertReady() {},
        audit: {
            createScope(toolName: string, input: unknown, callContext: typeof context) {
                return createToolCallScope(toolName, input as never, callContext);
            },
            async requested() { events.push("audit.requested"); },
            async queued() { events.push("audit.queued"); },
            runningContext() { return {}; },
            async running() { events.push("audit.running"); },
            async completed(_scope: unknown, _running: unknown, _approval: unknown, result: unknown) {
                events.push("audit.completed");
                completed.push(result);
            },
            async failed() { events.push("audit.failed"); },
            async failActive() { events.push("audit.failActive"); },
            async nonRunning() { events.push("audit.nonRunning"); },
        },
        boundary: async () => ({
            release() { events.push("boundary.release"); },
            sequence: new ToolCallBoundarySequence({
                reviews: [async (input) => {
                    reviewed.push({
                        direction: input.direction,
                        kind: input.kind,
                        payload: input.payload,
                    });
                    return { decision: "accept" };
                }],
                rewrites: [async (input) => {
                    events.push(`rewrite.${input.direction}.${input.kind}`);
                    return input.direction === "inbound"
                        ? input.text.replaceAll("${SECRET:github}", "real-token")
                        : input.text.replaceAll("real-token", "${SECRET:github}");
                }],
            }),
        }),
        instanceName: asInstanceName("boundary-outbound"),
        log: { async append() {} },
        toolCallScheduler: {
            reserve() {
                return {
                    markPendingApproval() {},
                    release() {},
                    async run(operation: () => Promise<unknown>) {
                        events.push("scheduler.run");
                        return await operation();
                    },
                };
            },
        },
        toolInvoker: {
            async invoke(_toolName: string, input: unknown, _context: unknown, _signal: unknown, onProgress?: (value: unknown) => void) {
                events.push("invoke");
                invoked.push(input);
                onProgress?.({ text: "progress real-token" });
                return { text: "result real-token" };
            },
        },
    } as never);

    const result = await execution.call(
        "bash_run",
        { command: "echo ${SECRET:github}" },
        context,
        undefined,
        async (raw) => ({
            text: `adapted ${(raw as { text: string }).text}`,
        }),
        { command: "wrapped ${SECRET:github}" },
        (value) => {
            events.push("progress.external");
            progress.push(value);
        },
    );

    assert.deepEqual(invoked, [{ command: "wrapped real-token" }]);
    assert.deepEqual(progress, [{ text: "progress ${SECRET:github}" }]);
    assert.deepEqual(completed, [{ text: "adapted result ${SECRET:github}" }]);
    assert.deepEqual(result, { text: "adapted result ${SECRET:github}" });
    assert.deepEqual(reviewed, [
        {
            direction: "inbound",
            kind: "call",
            payload: { command: "echo ${SECRET:github}" },
        },
        {
            direction: "outbound",
            kind: "progress",
            payload: { text: "progress ${SECRET:github}" },
        },
        {
            direction: "outbound",
            kind: "result",
            payload: { text: "adapted result ${SECRET:github}" },
        },
    ]);
    assert.equal(
        events.indexOf("audit.running") < events.indexOf("rewrite.inbound.call"),
        true,
    );
    assert.equal(
        events.indexOf("rewrite.outbound.result") < events.indexOf("audit.completed"),
        true,
    );
    assert.equal(events.at(-1), "boundary.release");
});

test("ToolCallExecution serializes asynchronous progress rewrites before completing the final result", async () => {
    const events: string[] = [];
    const execution = new ToolCallExecution({
        approval: { async prepare() { return {}; } },
        assertReady() {},
        audit: {
            createScope(toolName: string, input: unknown, callContext: typeof context) {
                return createToolCallScope(toolName, input as never, callContext);
            },
            async requested() {},
            async queued() {},
            runningContext() { return {}; },
            async running() {},
            async completed() { events.push("audit.completed"); },
            async failed() {},
            async failActive() {},
            async nonRunning() {},
        },
        boundary: async () => ({
            release() {},
            sequence: new ToolCallBoundarySequence({
                rewrites: [async (input) => {
                    if (input.kind === "progress") {
                        await new Promise<void>((resolve) => setTimeout(resolve, input.text === "one" ? 10 : 1));
                        events.push(`rewrite.${input.text}`);
                    }
                    return input.text;
                }],
            }),
        }),
        instanceName: asInstanceName("boundary-progress"),
        log: { async append() {} },
        toolCallScheduler: {
            reserve() {
                return {
                    markPendingApproval() {},
                    release() {},
                    async run(operation: () => Promise<unknown>) { return await operation(); },
                };
            },
        },
        toolInvoker: {
            async invoke(_toolName: string, _input: unknown, _context: unknown, _signal: unknown, onProgress?: (value: unknown) => void) {
                onProgress?.("one");
                onProgress?.("two");
                return "done";
            },
        },
    } as never);

    const result = await execution.call(
        "bash_run",
        {},
        context,
        undefined,
        undefined,
        undefined,
        (value) => events.push(`progress.${String(value)}`),
    );

    assert.equal(result, "done");
    assert.deepEqual(events, [
        "rewrite.one",
        "progress.one",
        "rewrite.two",
        "progress.two",
        "audit.completed",
    ]);
});

test("ToolCallExecution masks error message, details, and command streams before audit and delivery", async () => {
    const failedResults: unknown[] = [];
    const reviewed: unknown[] = [];
    const execution = new ToolCallExecution({
        approval: { async prepare() { return {}; } },
        assertReady() {},
        audit: {
            createScope(toolName: string, input: unknown, callContext: typeof context) {
                return createToolCallScope(toolName, input as never, callContext);
            },
            async requested() {},
            async queued() {},
            runningContext() { return {}; },
            async running() {},
            async completed() {},
            async failed(_scope: unknown, _running: unknown, _approval: unknown, _errorCode: string, result: unknown) {
                failedResults.push(result);
            },
            async failActive() {},
            async nonRunning() {},
        },
        boundary: async () => ({
            release() {},
            sequence: new ToolCallBoundarySequence({
                reviews: [async (input) => {
                    if (input.direction === "outbound" && input.kind === "error")
                        reviewed.push(input.payload);
                    return { decision: "accept" };
                }],
                rewrites: [async (input) =>
                    input.direction === "outbound"
                        ? input.text.replaceAll("real-token", "${SECRET:github}")
                        : input.text],
            }),
        }),
        instanceName: asInstanceName("boundary-error"),
        log: { async append() {} },
        toolCallScheduler: {
            reserve() {
                return {
                    markPendingApproval() {},
                    release() {},
                    async run(operation: () => Promise<unknown>) { return await operation(); },
                };
            },
        },
        toolInvoker: {
            async invoke() {
                const error = createError({
                    code: "tool.failed",
                    details: { token: "real-token" },
                    message: "failed with real-token",
                    retryable: false,
                });
                Object.assign(error, {
                    exitCode: 1,
                    stderr: "stderr real-token",
                    stdout: "stdout real-token",
                    timedOut: false,
                });
                throw error;
            },
        },
    } as never);

    await assert.rejects(
        execution.call("bash_run", {}, context),
        (error: unknown) => {
            const value = error as {
                details?: { token?: string };
                message?: string;
                stderr?: string;
                stdout?: string;
            };
            assert.equal(value.message, "failed with ${SECRET:github}");
            assert.equal(value.details?.token, "${SECRET:github}");
            assert.equal(value.stderr, "stderr ${SECRET:github}");
            assert.equal(value.stdout, "stdout ${SECRET:github}");
            return true;
        },
    );
    assert.deepEqual(failedResults, [
        {
            details: {},
            exitCode: 1,
            signal: undefined,
            stderr: "stderr ${SECRET:github}",
            stdout: "stdout ${SECRET:github}",
            timedOut: false,
        },
    ]);
    assert.equal(JSON.stringify(reviewed).includes("real-token"), false);
    assert.equal(JSON.stringify(reviewed).includes("${SECRET:github}"), true);
});

test("ToolCallExecution callOperation uses the same Boundary without requiring Worker readiness", async () => {
    const events: string[] = [];
    const reviews: string[] = [];
    const operationInputs: unknown[] = [];
    let readinessChecks = 0;
    const execution = new ToolCallExecution({
        approval: { async prepare() { return {}; } },
        assertReady() {
            readinessChecks += 1;
            throw new Error("Worker readiness must not gate Control-owned operations.");
        },
        audit: {
            createScope(toolName: string, input: unknown, callContext: typeof context) {
                return createToolCallScope(toolName, input as never, callContext);
            },
            async requested() { events.push("audit.requested"); },
            async queued() { events.push("audit.queued"); },
            runningContext() { return {}; },
            async running() { events.push("audit.running"); },
            async completed(_scope: unknown, _running: unknown, _approval: unknown, result: unknown) {
                events.push("audit.completed");
                assert.deepEqual(result, { value: "outer-result" });
            },
            async denied() {},
            async failed() {},
            async failActive() {},
            async nonRunning() {},
        },
        boundary: async () => ({
            release() { events.push("boundary.release"); },
            sequence: new ToolCallBoundarySequence({
                reviews: [async (input) => {
                    reviews.push(`${input.direction}:${input.kind}`);
                    return { decision: "accept" };
                }],
                rewrites: [async (input) =>
                    input.direction === "inbound"
                        ? input.text.replaceAll("outer", "inner")
                        : input.text.replaceAll("inner", "outer")],
            }),
        }),
        instanceName: asInstanceName("control-operation"),
        log: { async append() {} },
        toolCallScheduler: {
            reserve() {
                events.push("reserve");
                return {
                    markPendingApproval() {},
                    release() {},
                    async run(operation: () => Promise<unknown>) {
                        events.push("run");
                        return await operation();
                    },
                };
            },
        },
        toolInvoker: {
            async invoke() {
                throw new Error("Control-owned operation must not invoke Worker RPC.");
            },
        },
    } as never);

    const result = await execution.callOperation(
        "todo_read",
        { value: "outer-input" },
        context,
        async (callId, input) => {
            events.push("operation");
            assert.equal(callId.length > 0, true);
            operationInputs.push(input);
            return { value: "inner-result" };
        },
    );

    assert.equal(readinessChecks, 0);
    assert.deepEqual(operationInputs, [{ value: "inner-input" }]);
    assert.deepEqual(result, { value: "outer-result" });
    assert.deepEqual(reviews, ["inbound:call", "outbound:result"]);
    assert.deepEqual(events, [
        "audit.requested",
        "reserve",
        "audit.queued",
        "run",
        "audit.running",
        "operation",
        "audit.completed",
        "boundary.release",
    ]);
});
