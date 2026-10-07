import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    runtimeErrorCodes,
    type ApprovalRequest,
    type ToolCallHookRuntime,
    type ToolCallHooks,
    type ToolCallReviewHook,
    type ToolCallReviewInput,
} from "@portable-devshell/shared";
import type {
    ApprovalEvaluation,
    ApprovalEvaluationApi,
    ApprovalResolution,
} from "../../../src/approval/Api.ts";
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
    let registeredReview: ToolCallReviewHook | undefined;
    const hooks: ToolCallHooks = {
        registerContributor() {
            throw new Error("approval review must register only a review hook");
        },
        registerExecute() {
            throw new Error("approval review must register only a review hook");
        },
        registerReview(review) {
            registeredReview = review;
            return () => {
                if (registeredReview === review) registeredReview = undefined;
            };
        },
    };
    const approval: ApprovalEvaluationApi = {
        async evaluate(): Promise<ApprovalEvaluation> {
            assert.fail("review fixture must mock approval evaluation");
        },
    };
    registerApprovalToolCallReview(hooks, approval);
    return {
        approval,
        review: () => {
            assert.ok(registeredReview);
            return registeredReview;
        },
    };
}

async function runReview(
    review: ToolCallReviewHook,
    reviewInput: ToolCallReviewInput,
    signal: AbortSignal = new AbortController().signal,
    recording: "caller" | "host" = "host",
) {
    const runtime: ToolCallHookRuntime = { recording, signal };
    return await review.review(reviewInput, runtime);
}

test("review maps explicit ToolCall fields, forwards signal and holds until resolution", async (t) => {
    const { approval, review } = fixture();
    let resolve!: (resolution: ApprovalResolution) => void;
    const outcome = new Promise<ApprovalResolution>((done) => {
        resolve = done;
    });
    const request: ApprovalRequest = {
        approvalId: "approval-1",
        callId: "call-1",
        createdAt: "created",
        expiresAt: "expires",
        inputSummary: "{}",
        instance: asInstanceName("dev"),
        reason: "required",
        riskLevel: "medium",
        source: "mcp",
        status: "pending",
        toolName: "shell",
    };
    const evaluate = t.mock.method(
        approval,
        "evaluate",
        async (): Promise<ApprovalEvaluation> => ({
            decision: "ask",
            request,
            awaitDecision: outcome,
        }),
    );
    const controller = new AbortController();
    const addListener = t.mock.method(controller.signal, "addEventListener");
    const registered = review();
    let settled = false;
    const pending = runReview(
        registered,
        input,
        controller.signal,
        "caller",
    ).then((result) => {
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
        const { approval, review } = fixture();
        const evaluate = t.mock.method(approval, "evaluate", async () => {
            assert.fail("only inbound calls require approval");
        });
        assert.deepEqual(
            await runReview(
                review(),
                {
                    ...input,
                    direction,
                    value: { ...input.value, kind },
                },
            ),
            { decision: "continue" },
        );
        assert.equal(evaluate.mock.callCount(), 0);
    });
}

for (const decision of ["allow", "deny"] as const) {
    test(`review maps policy ${decision}`, async (t) => {
        const { approval, review } = fixture();
        const error = {
            code: runtimeErrorCodes.approvalDenied,
            message: "policy denied",
        };
        t.mock.method(approval, "evaluate", async () => ({ decision, error }));
        assert.deepEqual(await runReview(review(), input),
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
    test(`review maps ${status} resolution`, async (t) => {
        const { approval, review } = fixture();
        const code = {
            denied: runtimeErrorCodes.approvalDenied,
            cancelled: runtimeErrorCodes.toolCallCancelled,
            expired: runtimeErrorCodes.approvalExpired,
        }[status];
        const error = { code, message: `approval ${status}` };
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
        t.mock.method(approval, "evaluate", async () => ({
            decision: "ask",
            awaitDecision: Promise.resolve(resolution),
        }));
        assert.deepEqual(await runReview(review(), input), {
            decision: "reject",
            error: { code },
            reason: error.message,
        });
    });
}

test("review preserves the typed evaluation error code and message", async (t) => {
    const { approval, review } = fixture();
    t.mock.method(approval, "evaluate", async () => ({
        decision: "deny",
        error: { code: "approval.policy.denied", message: "Denied by policy." },
    }));
    assert.deepEqual(await runReview(review(), input), {
        decision: "reject",
        error: { code: "approval.policy.denied" },
        reason: "Denied by policy.",
    });
});
