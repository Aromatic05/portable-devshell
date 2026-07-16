import {
    createError,
    errorCodes,
    type ApprovalDecision,
    type JsonValue,
    type ToolCallQuery,
    type ToolCallSource,
    type ToolCallStatus
} from "@portable-devshell/shared";

export function readToolCall(payload?: JsonValue): { input: JsonValue; toolName: string } {
    if (!isRecord(payload) || typeof payload.toolName !== "string" || payload.toolName.length === 0) {
        throw invalid("tool.call requires toolName.");
    }
    return { input: payload.input ?? null, toolName: payload.toolName };
}

export function readToolCallQuery(payload?: JsonValue): ToolCallQuery {
    if (!isRecord(payload)) {
        return {};
    }
    if (payload.after !== undefined && typeof payload.after !== "string") {
        throw invalid("tool.listCalls requires string after.");
    }
    if (payload.before !== undefined && typeof payload.before !== "string") {
        throw invalid("tool.listCalls requires string before.");
    }
    if (payload.limit !== undefined && typeof payload.limit !== "number") {
        throw invalid("tool.listCalls requires numeric limit.");
    }
    if (payload.toolName !== undefined && typeof payload.toolName !== "string") {
        throw invalid("tool.listCalls requires string toolName.");
    }
    return {
        ...(payload.after === undefined ? {} : { after: payload.after }),
        ...(payload.before === undefined ? {} : { before: payload.before }),
        ...(payload.limit === undefined ? {} : { limit: payload.limit }),
        ...(payload.source === undefined ? {} : { source: readSource(payload.source) }),
        ...(payload.status === undefined ? {} : { status: readStatus(payload.status) }),
        ...(payload.toolName === undefined ? {} : { toolName: payload.toolName })
    };
}

export function readToolApprovalId(payload: JsonValue | undefined, operation: string): string {
    if (!isRecord(payload) || typeof payload.approvalId !== "string" || payload.approvalId.length === 0) {
        throw invalid(`${operation} requires approvalId.`);
    }
    return payload.approvalId;
}

export function readToolApprovalDecision(
    payload?: JsonValue
): { decision: ApprovalDecision["decision"]; policyPatch?: JsonValue; reason?: string; remember?: boolean } {
    if (!isRecord(payload) || (payload.decision !== "approve" && payload.decision !== "deny")) {
        throw invalid("tool.decideApproval requires decision to be approve or deny.");
    }
    if (payload.reason !== undefined && typeof payload.reason !== "string") {
        throw invalid("tool.decideApproval requires string reason.");
    }
    if (payload.remember !== undefined && typeof payload.remember !== "boolean") {
        throw invalid("tool.decideApproval requires boolean remember.");
    }
    return {
        decision: payload.decision,
        ...(payload.policyPatch === undefined ? {} : { policyPatch: payload.policyPatch }),
        ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        ...(payload.remember === undefined ? {} : { remember: payload.remember })
    };
}

function readSource(value: JsonValue): ToolCallSource {
    if (value === "cli" || value === "tui" || value === "mcp") {
        return value;
    }
    throw invalid("tool.listCalls requires source to be cli, tui, or mcp.");
}

function readStatus(value: JsonValue): ToolCallStatus {
    if (
        value === "pendingApproval" ||
        value === "running" ||
        value === "completed" ||
        value === "failed" ||
        value === "denied" ||
        value === "expired"
    ) {
        return value;
    }
    throw invalid("tool.listCalls received an invalid status.");
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string) {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}
