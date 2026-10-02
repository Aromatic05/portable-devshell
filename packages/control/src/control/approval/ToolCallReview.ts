import {
    errorCodes,
    errorMessage,
    type ApprovalDecision,
    type ApprovalRequest,
    type JsonValue,
    type ToolCallContext,
} from "@portable-devshell/shared";
import type {
    ToolCallReviewInput,
    ToolCallReviewResult,
} from "@portable-devshell/core";

import { ApprovalService, type ApprovalEventPort } from "./Service.js";

export interface ApprovalToolCallReviewOptions {
    service: ApprovalService;
    events: ApprovalEventPort;
}

export class ApprovalToolCallReview {
    readonly #service: ApprovalService;
    readonly #events: ApprovalEventPort;

    constructor(options: ApprovalToolCallReviewOptions) {
        this.#service = options.service;
        this.#events = options.events;
    }

    readonly review = async (
        input: ToolCallReviewInput,
        signal: AbortSignal,
        recording: "caller" | "host",
    ): Promise<ToolCallReviewResult> => {
        if (input.direction !== "inbound" || input.value.kind !== "call") {
            return { decision: "continue" };
        }

        const { instance: _instance, ...context } = input.value.context;
        const evaluation = await this.#service.evaluate({
            callId: input.callId,
            context: context as ToolCallContext,
            inputSummary: summarize(input.value.payload),
            recording,
            toolName: input.value.toolName,
        });
        if (evaluation.decision === "allow") return { decision: "continue" };
        if (evaluation.decision === "deny") {
            return reject(evaluation.error, errorCodes.coreApprovalDenied);
        }

        await this.#events.append(
            "approval.requested",
            eventData(evaluation.request),
        );
        const cancelPending = () => {
            void this.#service
                .cancel(
                    evaluation.request.approvalId,
                    abortReason(signal.reason),
                )
                .catch(() => undefined);
        };
        if (signal.aborted) cancelPending();
        else signal.addEventListener("abort", cancelPending, { once: true });

        let resolution: Awaited<typeof evaluation.awaitDecision>;
        try {
            resolution = await evaluation.awaitDecision;
        } finally {
            signal.removeEventListener("abort", cancelPending);
        }
        const request = await this.#service.getApproval(
            evaluation.request.approvalId,
        );
        if (resolution.status === "approved") {
            await this.#events.append(
                "approval.approved",
                eventData(request, resolution.decision),
            );
            return { decision: "continue" };
        }
        if (resolution.status === "denied") {
            await this.#events.append(
                "approval.denied",
                eventData(request, resolution.decision),
            );
            return reject(resolution.error, errorCodes.coreApprovalDenied);
        }
        if (resolution.status === "cancelled") {
            await this.#events.append("approval.cancelled", eventData(request));
            return reject(resolution.error, errorCodes.coreToolCallCancelled);
        }
        await this.#events.append("approval.expired", eventData(request));
        return reject(resolution.error, errorCodes.coreApprovalExpired);
    };
}

function abortReason(reason: unknown): string {
    if (reason instanceof Error && reason.message.length > 0) {
        return reason.message;
    }
    if (typeof reason === "string" && reason.length > 0) return reason;
    return "ToolCall was cancelled while awaiting approval.";
}

function summarize(value: JsonValue): string {
    const summary =
        Array.isArray(value) || (typeof value === "object" && value !== null)
            ? (JSON.stringify(value) ?? "null")
            : String(value);
    return summary.length <= 512 ? summary : `${summary.slice(0, 511)}…`;
}

function eventData(
    request: ApprovalRequest,
    decision?: ApprovalDecision,
): Record<string, JsonValue> {
    const fields: Record<string, JsonValue | undefined> = {
        approvalId: request.approvalId,
        callId: request.callId,
        createdAt: request.createdAt,
        decidedAt: decision?.decidedAt,
        decidedBy: decision?.decidedBy,
        decision: decision?.decision,
        expiresAt: request.expiresAt,
        inputSummary: request.inputSummary,
        reason: decision?.reason ?? request.reason,
        recording: request.recording,
        requestId: request.requestId,
        remember: decision?.remember,
        riskLevel: request.riskLevel,
        ctxId: request.ctxId,
        extensionId: request.extensionId,
        source: request.source,
        status: request.status,
        toolName: request.toolName,
        workspace: request.workspace,
    };
    return Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as Record<string, JsonValue>;
}

function reject(error: unknown, fallback: string): ToolCallReviewResult {
    const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
            ? error.code
            : fallback;
    return {
        decision: "reject",
        error: { code },
        reason: errorMessage(error),
    };
}
