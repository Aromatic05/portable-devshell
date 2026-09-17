import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes, asInstanceName } from "@portable-devshell/shared";

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
        boundary: () =>
            new ToolCallBoundarySequence({
                reviews: [async () => {
                    events.push("review");
                    return { decision };
                }],
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
    return { approvalInputs, denied, events, execution, invokes: () => invokes };
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
