import {
    runtimeErrorCodes,
    errorMessage,
    type JsonValue,
} from "@portable-devshell/shared";
import type {
    ToolCallReviewInput,
    ToolCallReviewResult,
} from "@portable-devshell/core";

import { ApprovalService } from "./Service.js";

export interface ApprovalToolCallReviewOptions {
    service: ApprovalService;
}

export class ApprovalToolCallReview {
    readonly #service: ApprovalService;

    constructor(options: ApprovalToolCallReviewOptions) {
        this.#service = options.service;
    }

    readonly review = async (
        input: ToolCallReviewInput,
        signal: AbortSignal,
        recording: "caller" | "host",
    ): Promise<ToolCallReviewResult> => {
        if (input.direction !== "inbound" || input.value.kind !== "call") {
            return { decision: "continue" };
        }

        const { source, requestId, ctxId, workspace } = input.value.context;
        const evaluation = await this.#service.evaluate({
            callId: input.callId,
            source,
            requestId,
            ctxId,
            workspace,
            inputSummary: summarize(input.value.payload),
            recording,
            toolName: input.value.toolName,
        }, signal);
        if (evaluation.decision === "allow") return { decision: "continue" };
        if (evaluation.decision === "deny") {
            return reject(evaluation.error, runtimeErrorCodes.approvalDenied);
        }

        const resolution = await evaluation.awaitDecision;
        if (resolution.status === "approved") {
            return { decision: "continue" };
        }
        if (resolution.status === "denied") {
            return reject(resolution.error, runtimeErrorCodes.approvalDenied);
        }
        if (resolution.status === "cancelled") {
            return reject(resolution.error, runtimeErrorCodes.toolCallCancelled);
        }
        return reject(resolution.error, runtimeErrorCodes.approvalExpired);
    };
}

function summarize(value: JsonValue): string {
    const summary =
        Array.isArray(value) || (typeof value === "object" && value !== null)
            ? (JSON.stringify(value) ?? "null")
            : String(value);
    return summary.length <= 512 ? summary : `${summary.slice(0, 511)}…`;
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
