import {
    errorCodes,
    errorMessage,
    type ApprovalDecision,
    type ApprovalRequest,
    type JsonValue,
    type ToolCallContext,
} from "@portable-devshell/shared";

import type { ApprovalManager } from "../approval/Manager.js";
import type { InstanceEventInput } from "../instance/EventBuffer.js";
import { readWorkerAbortReason } from "../worker/AbortReason.js";
import { getErrorCode } from "../worker/instance/state/Error.js";
import {
    toApprovalEventData,
    toEventData,
} from "../worker/instance/state/Event.js";
import { summarizeToolCallInput } from "./Context.js";
import type {
    ToolCallReviewInput,
    ToolCallReviewResult,
} from "./hook/Review.js";

interface ToolCallApprovalOptions {
    approvalManager: ApprovalManager;
    appendEvent(
        type: InstanceEventInput["type"],
        data?: JsonValue,
    ): Promise<unknown>;
}

export class ToolCallApproval {
    readonly #approvalManager: ApprovalManager;
    readonly #appendEvent: ToolCallApprovalOptions["appendEvent"];

    constructor(options: ToolCallApprovalOptions) {
        this.#approvalManager = options.approvalManager;
        this.#appendEvent = options.appendEvent;
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        return await this.#approvalManager.listApprovals();
    }

    async listPendingApprovals(ctxId?: string): Promise<ApprovalRequest[]> {
        return await this.#approvalManager.listPendingApprovals(ctxId);
    }

    async getApproval(approvalId: string): Promise<ApprovalRequest> {
        return await this.#approvalManager.getApproval(approvalId);
    }

    async decideApproval(
        approvalId: string,
        input: {
            decision: ApprovalDecision["decision"];
            decidedBy: ApprovalDecision["decidedBy"];
            policyPatch?: JsonValue;
            reason?: string;
            remember?: boolean;
        },
    ): Promise<ApprovalRequest> {
        return await this.#approvalManager.decideApproval(approvalId, input);
    }

    async cancelApproval(
        approvalId: string,
        reason?: string,
    ): Promise<ApprovalRequest> {
        return await this.#approvalManager.cancel(approvalId, reason);
    }

    async review(
        input: ToolCallReviewInput,
        signal: AbortSignal,
        recording: "caller" | "host",
    ): Promise<ToolCallReviewResult> {
        if (input.direction !== "inbound" || input.value.kind !== "call")
            return { decision: "continue" };

        const { instance: _instance, ...context } = input.value.context;
        const startedAt = new Date().toISOString();
        const inputSummary = summarizeToolCallInput(input.value.payload);
        const evaluation = await this.#approvalManager.evaluate({
            callId: input.callId,
            context,
            inputSummary,
            recording,
            toolName: input.value.toolName,
        });

        if (evaluation.decision === "allow")
            return { decision: "continue" };
        if (evaluation.decision === "deny")
            return rejection(
                evaluation.error,
                errorCodes.coreApprovalDenied,
            );

        await this.#appendEvent(
            "approval.requested",
            toApprovalEventData(evaluation.request),
        );
        if (recording === "host") {
            await this.#appendEvent(
                "toolCall.pendingApproval",
                toEventData({
                    approvalId: evaluation.request.approvalId,
                    callId: input.callId,
                    createdAt: evaluation.request.createdAt,
                    expiresAt: evaluation.request.expiresAt,
                    inputSummary,
                    reason: evaluation.request.reason,
                    requestId: context.requestId,
                    ctxId: context.ctxId,
                    extensionId: context.extensionId,
                    source: context.source,
                    startedAt,
                    status: "pendingApproval",
                    toolName: input.value.toolName,
                }),
            );
        }

        const onAbort = () => {
            void this.#approvalManager
                .cancel(
                    evaluation.request.approvalId,
                    readWorkerAbortReason(signal.reason),
                )
                .catch(() => undefined);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });

        let resolution: Awaited<typeof evaluation.awaitDecision>;
        try {
            resolution = await evaluation.awaitDecision;
        } finally {
            signal.removeEventListener("abort", onAbort);
        }

        const request = await this.#approvalManager.getApproval(
            evaluation.request.approvalId,
        );
        if (resolution.status === "approved") {
            await this.#appendEvent(
                "approval.approved",
                toApprovalEventData(request, resolution.decision),
            );
            return { decision: "continue" };
        }
        if (resolution.status === "denied") {
            await this.#appendEvent(
                "approval.denied",
                toApprovalEventData(request, resolution.decision),
            );
            return rejection(
                resolution.error,
                errorCodes.coreApprovalDenied,
            );
        }
        if (resolution.status === "cancelled") {
            await this.#appendEvent(
                "approval.cancelled",
                toApprovalEventData(request),
            );
            return rejection(
                resolution.error,
                errorCodes.coreToolCallCancelled,
            );
        }
        await this.#appendEvent(
            "approval.expired",
            toApprovalEventData(request),
        );
        return rejection(
            resolution.error,
            errorCodes.coreApprovalExpired,
        );
    }
}

function rejection(
    error: unknown,
    fallbackCode: string,
): ToolCallReviewResult {
    return {
        decision: "reject",
        error: { code: getErrorCode(error, fallbackCode) },
        reason: errorMessage(error),
    };
}
