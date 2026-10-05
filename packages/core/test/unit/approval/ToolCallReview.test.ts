import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, runtimeErrorCodes } from "@portable-devshell/shared";
import {
    ToolCallHookRegistry,
    type ToolCallReviewInput,
} from "@portable-devshell/core/testing";

import type {
    ApprovalEvaluation,
    ApprovalResolution,
} from "../../../src/approval/Api.ts";
import {
    ApprovalError,
    ApprovalService,
} from "../../../src/approval/execution/Service.ts";
import { registerApprovalToolCallReview } from "../../../src/approval/execution/ToolCallReview.ts";

const input: ToolCallReviewInput = {
    callId: "call-1",
    direction: "inbound",
    value: {
        kind: "call",
        context: {
            instance: asInstanceName("dev"),
            source: "mcp",
            requestId: "request-1",
            ctxId: "ctx-1",
            workspace: "/workspace",
            operationId: "not-an-approval-field",
        },
        payload: { command: "pwd" },
        toolName: "shell",
    },
};

function fixture() {
    const service = new ApprovalService({
        instanceName: asInstanceName("dev"),
        store: {
            append: async () => {
                assert.fail("review must only evaluate and wait");
            },
            delete: async () => {
                assert.fail("review must not prune approvals");
            },
            get: async () => {
                assert.fail("review must not re-read approvals");
            },
            list: async () => {
                assert.fail("review must not query approvals");
            },
        },
        events: {
            append: async () => {
                assert.fail("review must not append events");
            },
        },
    });
    const hooks = new ToolCallHookRegistry();
    registerApprovalToolCallReview(hooks, (instance) =>
        instance === "dev" ? service : undefined,
    );
    return { hooks, service };
}

async function acquire(
    hooks: ToolCallHookRegistry,
    reviewInput: ToolCallReviewInput,
    signal: AbortSignal,
    recording: "caller" | "host",
) {
    return await hooks.provider()(reviewInput.value.context, signal, recording);
}

async function runReview(
    hooks: ToolCallHookRegistry,
    reviewInput: ToolCallReviewInput,
    signal: AbortSignal,
    recording: "caller" | "host",
) {
    const lease = await acquire(hooks, reviewInput, signal, recording);
    try {
        return await lease.sequence.review(reviewInput);
    } finally {
        lease.release();
    }
}

test("review maps explicit ToolCall fields, forwards signal and holds until resolution", async (t) => {
    const { hooks, service } = fixture();
    let resolve!: (resolution: ApprovalResolution) => void;
    const outcome = new Promise<ApprovalResolution>((done) => {
        resolve = done;
    });
    const request = {
        approvalId: "approval-1",
        callId: "call-1",
        createdAt: "created",
        expiresAt: "expires",
        inputSummary: "{}",
        instance: asInstanceName("dev"),
        reason: "required",
        riskLevel: "medium" as const,
        source: "mcp" as const,
        status: "pending" as const,
        toolName: "shell",
    };
    const evaluate = t.mock.method(
        service,
        "evaluate",
        async (): Promise<ApprovalEvaluation> => ({
            decision: "ask",
            request,
            awaitDecision: outcome,
        }),
    );
    const controller = new AbortController();
    const addListener = t.mock.method(controller.signal, "addEventListener");
    const cancel = t.mock.method(service, "cancel", async () => {
        assert.fail("review must not cancel directly");
    });
    const lease = await acquire(hooks, input, controller.signal, "caller");
    let settled = false;
    const pending = lease.sequence.review(input).then((result) => {
        settled = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(evaluate.mock.calls[0].arguments, [
        {
            callId: "call-1",
            source: "mcp",
            requestId: "request-1",
            ctxId: "ctx-1",
            workspace: "/workspace",
            inputSummary: '{"command":"pwd"}',
            recording: "caller",
            toolName: "shell",
        },
        controller.signal,
    ]);
    controller.abort("cancelled");
    assert.equal(addListener.mock.callCount(), 0);
    assert.equal(cancel.mock.callCount(), 0);
    resolve({
        status: "approved",
        decision: {
            approvalId: "approval-1",
            decidedAt: "decided",
            decidedBy: "cli",
            decision: "approve",
        },
    });
    assert.deepEqual(await pending, { decision: "continue" });
    lease.release();
});

for (const [direction, kind] of [
    ["inbound", "result"],
    ["inbound", "error"],
    ["inbound", "progress"],
    ["outbound", "call"],
    ["outbound", "result"],
    ["outbound", "error"],
    ["outbound", "progress"],
] as const) {
    test(`review skips ${direction} ${kind}`, async (t) => {
        const { hooks, service } = fixture();
        const evaluate = t.mock.method(service, "evaluate", async () => {
            assert.fail("non-inbound calls must not request approval");
        });
        assert.deepEqual(
            await runReview(
                hooks,
                {
                    ...input,
                    direction,
                    value: { ...input.value, kind },
                },
                new AbortController().signal,
                "host",
            ),
            { decision: "continue" },
        );
        assert.equal(evaluate.mock.callCount(), 0);
    });
}

for (const decision of ["allow", "deny"] as const) {
    test(`review maps policy ${decision}`, async (t) => {
        const { hooks, service } = fixture();
        const error = new ApprovalError(
            runtimeErrorCodes.approvalDenied,
            "policy denied",
        );
        t.mock.method(service, "evaluate", async () => ({ decision, error }));
        assert.deepEqual(
            await runReview(
                hooks,
                input,
                new AbortController().signal,
                "host",
            ),
            decision === "allow"
                ? { decision: "continue" }
                : {
                      decision: "reject",
                      error: { code: error.code },
                      reason: error.message,
                  },
        );
    });
}

for (const status of ["denied", "cancelled", "expired"] as const) {
    test(`review maps ${status} resolution without reading persistence`, async (t) => {
        const { hooks, service } = fixture();
        const code = {
            denied: runtimeErrorCodes.approvalDenied,
            cancelled: runtimeErrorCodes.toolCallCancelled,
            expired: runtimeErrorCodes.approvalExpired,
        }[status];
        const error = new ApprovalError(code, `approval ${status}`);
        const decision = {
            approvalId: "approval-1",
            decidedAt: "decided",
            decidedBy: "cli" as const,
            decision: "deny" as const,
        };
        const resolution: ApprovalResolution =
            status === "denied"
                ? { status, decision, error }
                : { status, error };
        t.mock.method(service, "evaluate", async () => ({
            decision: "ask",
            awaitDecision: Promise.resolve(resolution),
        }));
        assert.deepEqual(
            await runReview(
                hooks,
                input,
                new AbortController().signal,
                "host",
            ),
            {
                decision: "reject",
                error: { code },
                reason: error.message,
            },
        );
    });
}

test("review preserves the typed evaluation error code and message", async (t) => {
    const { hooks, service } = fixture();
    t.mock.method(service, "evaluate", async () => ({
        decision: "deny",
        error: { code: "approval.policy.denied", message: "Denied by policy." },
    }));
    assert.deepEqual(
        await runReview(hooks, input, new AbortController().signal, "host"),
        {
            decision: "reject",
            error: { code: "approval.policy.denied" },
            reason: "Denied by policy.",
        },
    );
});
