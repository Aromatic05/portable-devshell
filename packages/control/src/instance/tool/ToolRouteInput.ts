import {
    createError,
    errorCodes,
    type ApprovalDecision,
    type JsonValue,
    type ToolCallQuery,
    type ToolCallRecord,
    type ToolCallSource,
    type ToolCallStatus
} from "@portable-devshell/shared";

const DEFAULT_TOOL_CALL_READ_LIMIT = 200;
const MAX_TOOL_CALL_READ_LIMIT = 1_000;
const MAX_TOOL_CALL_RESPONSE_BYTES = 8 * 1024 * 1024;

export function readToolCall(payload?: JsonValue): { input: JsonValue; toolName: string; workspace: string } {
    if (!isRecord(payload) || typeof payload.toolName !== "string" || payload.toolName.length === 0) {
        throw invalid("tool.call requires toolName.");
    }
    if (typeof payload.workspace !== "string" || payload.workspace.trim().length === 0) {
        throw invalid("tool.call requires workspace.");
    }
    return { input: payload.input ?? null, toolName: payload.toolName, workspace: payload.workspace };
}

export function readToolCallQuery(payload?: JsonValue): ToolCallQuery {
    if (!isRecord(payload)) {
        return { limit: DEFAULT_TOOL_CALL_READ_LIMIT };
    }
    if (payload.after !== undefined && typeof payload.after !== "string") {
        throw invalid("tool.listCalls requires string after.");
    }
    if (payload.before !== undefined && typeof payload.before !== "string") {
        throw invalid("tool.listCalls requires string before.");
    }
    if (payload.limit !== undefined && (typeof payload.limit !== "number" || !Number.isSafeInteger(payload.limit))) {
        throw invalid("tool.listCalls requires integer limit.");
    }
    if (payload.ctxId !== undefined && typeof payload.ctxId !== "string") {
        throw invalid("tool.listCalls requires string ctxId.");
    }
    const callIds = payload.callIds === undefined
        ? undefined
        : readCallIds(payload.callIds);
    if (payload.toolName !== undefined && typeof payload.toolName !== "string") {
        throw invalid("tool.listCalls requires string toolName.");
    }
    return {
        ...(payload.after === undefined ? {} : { after: payload.after }),
        ...(payload.before === undefined ? {} : { before: payload.before }),
        ...(callIds === undefined ? {} : { callIds }),
        ...(payload.ctxId === undefined ? {} : { ctxId: payload.ctxId }),
        limit: readToolCallLimit(payload.limit),
        ...(payload.source === undefined ? {} : { source: readSource(payload.source) }),
        ...(payload.status === undefined ? {} : { status: readStatus(payload.status) }),
        ...(payload.toolName === undefined ? {} : { toolName: payload.toolName })
    };
}

export function limitToolCallResponse(records: ToolCallRecord[], query: ToolCallQuery): ToolCallRecord[] {
    const newestFirst = query.after === undefined;
    const candidates = newestFirst ? [...records].reverse() : records;
    const accepted: ToolCallRecord[] = [];
    let responseBytes = 2;
    for (const record of candidates) {
        const separatorBytes = accepted.length === 0 ? 0 : 1;
        const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
        if (responseBytes + separatorBytes + recordBytes > MAX_TOOL_CALL_RESPONSE_BYTES) {
            if (accepted.length === 0) {
                throw invalid(`tool.listCalls record ${record.callId} exceeds the safe response size.`);
            }
            break;
        }
        if (newestFirst) accepted.unshift(record);
        else accepted.push(record);
        responseBytes += separatorBytes + recordBytes;
    }
    return accepted;
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

function readCallIds(value: JsonValue): string[] {
    if (!Array.isArray(value)) {
        throw invalid("tool.listCalls requires non-empty string callIds.");
    }
    const callIds: string[] = [];
    for (const callId of value) {
        if (typeof callId !== "string" || callId.length === 0) {
            throw invalid("tool.listCalls requires non-empty string callIds.");
        }
        callIds.push(callId);
    }
    return callIds;
}

function readToolCallLimit(value: JsonValue | undefined): number {
    if (value === undefined) return DEFAULT_TOOL_CALL_READ_LIMIT;
    return Math.min(Math.max(value as number, 1), MAX_TOOL_CALL_READ_LIMIT);
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string) {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}
