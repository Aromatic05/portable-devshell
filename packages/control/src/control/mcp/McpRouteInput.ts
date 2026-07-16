import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

export function readMcpApprovalId(payload?: JsonValue): string {
    if (!isRecord(payload) || typeof payload.approvalId !== "string" || payload.approvalId.length === 0) {
        throw invalid("mcp.decideApproval requires approvalId.");
    }
    return payload.approvalId;
}

export function readMcpApprovalDecision(payload?: JsonValue): "approve" | "deny" {
    if (!isRecord(payload) || (payload.decision !== "approve" && payload.decision !== "deny")) {
        throw invalid("mcp.decideApproval requires decision approve or deny.");
    }
    return payload.decision;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string) {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}
