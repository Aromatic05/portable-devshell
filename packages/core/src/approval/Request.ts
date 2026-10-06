import {
    createRemoteError,
    controlErrorCodes,
    type JsonValue,
} from "@portable-devshell/shared";
import type { ApprovalDecisionInput } from "./Api.js";

export function readApprovalId(
    payload: JsonValue | undefined,
    operation: string,
): string {
    if (
        !isRecord(payload) ||
        typeof payload.approvalId !== "string" ||
        payload.approvalId.length === 0
    ) {
        throw invalid(`${operation} requires approvalId.`);
    }
    return payload.approvalId;
}

export function readApprovalListOptions(payload?: JsonValue): {
    pendingOnly: boolean;
} {
    if (payload === undefined) return { pendingOnly: false };
    if (
        !isRecord(payload) ||
        (payload.pendingOnly !== undefined &&
            typeof payload.pendingOnly !== "boolean")
    ) {
        throw invalid("approval.list requires boolean pendingOnly.");
    }
    return { pendingOnly: payload.pendingOnly === true };
}

export function readApprovalSubscriptionFromSeq(payload?: JsonValue): number {
    if (
        !isRecord(payload) ||
        typeof payload.fromSeq !== "number" ||
        !Number.isSafeInteger(payload.fromSeq) ||
        payload.fromSeq < 0
    ) {
        throw invalid(
            "approval.subscribe requires a non-negative integer fromSeq.",
        );
    }
    return payload.fromSeq;
}

export function readApprovalDecision(
    payload?: JsonValue,
): Omit<ApprovalDecisionInput, "decidedBy"> {
    if (
        !isRecord(payload) ||
        (payload.decision !== "approve" && payload.decision !== "deny")
    ) {
        throw invalid(
            "approval.decide requires decision to be approve or deny.",
        );
    }
    if (payload.reason !== undefined && typeof payload.reason !== "string") {
        throw invalid("approval.decide requires string reason.");
    }
    if (
        payload.remember !== undefined &&
        typeof payload.remember !== "boolean"
    ) {
        throw invalid("approval.decide requires boolean remember.");
    }
    return {
        decision: payload.decision,
        ...(payload.policyPatch === undefined
            ? {}
            : { policyPatch: payload.policyPatch }),
        ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        ...(payload.remember === undefined
            ? {}
            : { remember: payload.remember }),
    };
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string) {
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message,
        retryable: false,
    });
}
