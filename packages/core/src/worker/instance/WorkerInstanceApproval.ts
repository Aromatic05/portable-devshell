import {
    errorCodes,
    type ApprovalDecision,
    type ApprovalRequest,
    type JsonValue,
    type ToolCallApprovalDecision,
    type ToolCallContext
} from "@portable-devshell/shared";

import type { ApprovalManager } from "../../approval/ApprovalInfra.js";
import { readWorkerAbortReason } from "../WorkerAbortReason.js";
import type { InstanceEventInput } from "../../log/LogEventBuffer.js";
import type { ToolCallHistory } from "../../log/LogToolCallHistory.js";
import { getErrorCode } from "./WorkerInstanceError.js";
import { toApprovalEventData, toEventData } from "./WorkerInstanceEvent.js";

interface WorkerInstanceApprovalOptions {
    approvalManager: ApprovalManager;
    appendEvent(type: InstanceEventInput["type"], data?: JsonValue): Promise<unknown>;
    toolCallHistory: ToolCallHistory;
}

export class WorkerInstanceApproval {
    readonly #approvalManager: ApprovalManager;
    readonly #appendEvent: WorkerInstanceApprovalOptions["appendEvent"];
    readonly #toolCallHistory: ToolCallHistory;

    constructor(options: WorkerInstanceApprovalOptions) {
        this.#approvalManager = options.approvalManager;
        this.#appendEvent = options.appendEvent;
        this.#toolCallHistory = options.toolCallHistory;
    }

    async listApprovals(): Promise<ApprovalRequest[]> {
        return await this.#approvalManager.listApprovals();
    }

    async getApproval(approvalId: string): Promise<ApprovalRequest> {
        return await this.#approvalManager.getApproval(approvalId);
    }

    async decideApproval(
        approvalId: string,
        input: { decision: ApprovalDecision["decision"]; decidedBy: ApprovalDecision["decidedBy"]; policyPatch?: JsonValue; reason?: string; remember?: boolean }
    ): Promise<ApprovalRequest> {
        return await this.#approvalManager.decideApproval(approvalId, input);
    }

    async prepare(
        callId: string,
        toolName: string,
        inputSummary: string,
        context: ToolCallContext,
        startedAt: string,
        onPendingApproval: () => void,
        signal?: AbortSignal
    ): Promise<{ approvalId?: string; decision?: ToolCallApprovalDecision }> {
        let evaluation: Awaited<ReturnType<ApprovalManager["evaluate"]>>;

        try {
            evaluation = await this.#approvalManager.evaluate({
                callId,
                context,
                inputSummary,
                toolName
            });
        } catch (error) {
            return await this.#failBeforeInvoke(callId, toolName, context, startedAt, error);
        }

        if (evaluation.decision === "allow") {
            return {};
        }

        if (evaluation.decision === "deny") {
            return await this.#denyToolCall(callId, toolName, context, startedAt, evaluation.error);
        }

        onPendingApproval();
        await this.#toolCallHistory.pendingApproval(callId, evaluation.request.approvalId);
        await this.#appendEvent("approval.requested", toApprovalEventData(evaluation.request));
        await this.#appendEvent(
            "toolCall.pendingApproval",
            toEventData({
                approvalId: evaluation.request.approvalId,
                callId,
                createdAt: evaluation.request.createdAt,
                expiresAt: evaluation.request.expiresAt,
                inputSummary,
                reason: evaluation.request.reason,
                requestId: context.requestId,
                riskLevel: evaluation.request.riskLevel,
                ctxId: context.ctxId,
                source: context.source,
                startedAt,
                status: "pendingApproval",
                toolName
            })
        );

        const onAbort = () => {
            void this.#approvalManager.cancel(evaluation.request.approvalId, readWorkerAbortReason(signal?.reason));
        };
        if (signal?.aborted === true) {
            await this.#approvalManager.cancel(evaluation.request.approvalId, readWorkerAbortReason(signal.reason));
        } else {
            signal?.addEventListener("abort", onAbort, { once: true });
        }

        let resolution: Awaited<typeof evaluation.awaitDecision>;
        try {
            resolution = await evaluation.awaitDecision;
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }

        if (resolution.status === "approved") {
            const approvedRequest = await this.#approvalManager.getApproval(evaluation.request.approvalId);
            await this.#appendEvent("approval.approved", toApprovalEventData(approvedRequest, resolution.decision));
            return {
                approvalId: evaluation.request.approvalId,
                decision: "approved"
            };
        }

        if (resolution.status === "denied") {
            const deniedRequest = await this.#approvalManager.getApproval(evaluation.request.approvalId);
            await this.#appendEvent("approval.denied", toApprovalEventData(deniedRequest, resolution.decision));
            return await this.#denyToolCall(callId, toolName, context, startedAt, resolution.error, evaluation.request.approvalId);
        }

        if (resolution.status === "cancelled") {
            const cancelledRequest = await this.#approvalManager.getApproval(evaluation.request.approvalId);
            await this.#appendEvent("approval.cancelled", toApprovalEventData(cancelledRequest));
            return await this.#cancelToolCall(callId, toolName, context, startedAt, resolution.error, evaluation.request.approvalId);
        }

        const expiredRequest = await this.#approvalManager.getApproval(evaluation.request.approvalId);
        await this.#appendEvent("approval.expired", toApprovalEventData(expiredRequest));
        return await this.#expireToolCall(callId, toolName, context, startedAt, resolution.error, evaluation.request.approvalId);
    }

    async #failBeforeInvoke(
        callId: string,
        toolName: string,
        context: ToolCallContext,
        startedAt: string,
        error: unknown
    ): Promise<never> {
        const completedAt = new Date().toISOString();
        const errorCode = getErrorCode(error, errorCodes.coreProviderFailed);

        await this.#toolCallHistory.failed(callId, errorCode, completedAt);
        await this.#appendEvent(
            "toolCall.failed",
            toEventData({
                callId,
                completedAt,
                errorCode,
                requestId: context.requestId,
                ctxId: context.ctxId,
                source: context.source,
                startedAt,
                status: "failed",
                toolName
            })
        );

        throw error;
    }

    async #denyToolCall(
        callId: string,
        toolName: string,
        context: ToolCallContext,
        startedAt: string,
        error: unknown,
        approvalId?: string
    ): Promise<never> {
        const completedAt = new Date().toISOString();
        const errorCode = getErrorCode(error, errorCodes.coreApprovalDenied);

        await this.#toolCallHistory.denied(callId, errorCode, completedAt);
        await this.#appendEvent(
            "toolCall.denied",
            toEventData({
                ...(approvalId === undefined ? {} : { approvalId }),
                callId,
                completedAt,
                errorCode,
                requestId: context.requestId,
                ctxId: context.ctxId,
                source: context.source,
                startedAt,
                status: "denied",
                toolName
            })
        );

        throw error;
    }

    async #cancelToolCall(
        callId: string,
        toolName: string,
        context: ToolCallContext,
        startedAt: string,
        error: unknown,
        approvalId: string
    ): Promise<never> {
        const completedAt = new Date().toISOString();
        const errorCode = getErrorCode(error, errorCodes.coreToolCallCancelled);

        await this.#toolCallHistory.cancelled(callId, errorCode, completedAt);
        await this.#appendEvent(
            "toolCall.cancelled",
            toEventData({
                approvalId,
                callId,
                completedAt,
                errorCode,
                requestId: context.requestId,
                ctxId: context.ctxId,
                source: context.source,
                startedAt,
                status: "cancelled",
                toolName
            })
        );

        throw error;
    }

    async #expireToolCall(
        callId: string,
        toolName: string,
        context: ToolCallContext,
        startedAt: string,
        error: unknown,
        approvalId: string
    ): Promise<never> {
        const completedAt = new Date().toISOString();
        const errorCode = getErrorCode(error, errorCodes.coreApprovalExpired);

        await this.#toolCallHistory.expired(callId, errorCode, completedAt);
        await this.#appendEvent(
            "toolCall.expired",
            toEventData({
                approvalId,
                callId,
                completedAt,
                errorCode,
                requestId: context.requestId,
                ctxId: context.ctxId,
                source: context.source,
                startedAt,
                status: "expired",
                toolName
            })
        );

        throw error;
    }

}
