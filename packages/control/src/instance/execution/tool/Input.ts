import {
    asInstanceName,
    createRemoteError,
    controlErrorCodes,
    type InstanceName,
    type JsonValue,
    type ToolCallQuery,
    type ToolCallRecord,
    type ToolCallSource,
    type ToolCallStatus,
} from "@portable-devshell/shared";

const DEFAULT_TOOL_CALL_READ_LIMIT = 200;
const MAX_TOOL_CALL_READ_LIMIT = 1_000;
const MAX_TOOL_CALL_RESPONSE_BYTES = 8 * 1024 * 1024;

export function readToolCall(payload?: JsonValue): {
    instance: InstanceName;
    input: JsonValue;
    operationId?: string;
    recording?: "caller" | "host";
    toolName: string;
    workspace: string;
} {
    if (
        !isRecord(payload) ||
        typeof payload.toolName !== "string" ||
        payload.toolName.length === 0
    ) {
        throw invalid("tool.call requires toolName.");
    }
    if (
        typeof payload.instance !== "string" ||
        payload.instance.length === 0
    ) {
        throw invalid("tool.call requires instance.");
    }
    if (
        typeof payload.workspace !== "string" ||
        payload.workspace.trim().length === 0
    ) {
        throw invalid("tool.call requires workspace.");
    }
    if (
        payload.operationId !== undefined &&
        (typeof payload.operationId !== "string" ||
            payload.operationId.length === 0)
    ) {
        throw invalid("tool.call operationId must be a non-empty string.");
    }
    if (
        payload.recording !== undefined &&
        payload.recording !== "caller" &&
        payload.recording !== "host"
    ) {
        throw invalid("tool.call recording must be caller or host.");
    }
    return {
        instance: asInstanceName(payload.instance),
        input: payload.input ?? null,
        ...(payload.operationId === undefined
            ? {}
            : { operationId: payload.operationId }),
        ...(payload.recording === undefined
            ? {}
            : { recording: payload.recording }),
        toolName: payload.toolName,
        workspace: payload.workspace,
    };
}

export function readToolSessionOpen(payload?: JsonValue): {
    workspace: string;
} {
    if (
        !isRecord(payload) ||
        typeof payload.workspace !== "string" ||
        payload.workspace.trim().length === 0
    ) {
        throw invalid("tool.openSession requires workspace.");
    }
    return { workspace: payload.workspace };
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
    if (
        payload.limit !== undefined &&
        (typeof payload.limit !== "number" ||
            !Number.isSafeInteger(payload.limit))
    ) {
        throw invalid("tool.listCalls requires integer limit.");
    }
    if (payload.ctxId !== undefined && typeof payload.ctxId !== "string") {
        throw invalid("tool.listCalls requires string ctxId.");
    }
    if (
        payload.workspace !== undefined &&
        typeof payload.workspace !== "string"
    ) {
        throw invalid("tool.listCalls requires string workspace.");
    }
    if (
        payload.includeInput !== undefined &&
        typeof payload.includeInput !== "boolean"
    ) {
        throw invalid("tool.listCalls requires boolean includeInput.");
    }
    if (
        payload.includeOutput !== undefined &&
        typeof payload.includeOutput !== "boolean"
    ) {
        throw invalid("tool.listCalls requires boolean includeOutput.");
    }
    if (
        payload.maxBytes !== undefined &&
        (typeof payload.maxBytes !== "number" ||
            !Number.isSafeInteger(payload.maxBytes))
    ) {
        throw invalid("tool.listCalls requires integer maxBytes.");
    }
    const callIds =
        payload.callIds === undefined
            ? undefined
            : readCallIds(payload.callIds);
    if (
        payload.toolName !== undefined &&
        typeof payload.toolName !== "string"
    ) {
        throw invalid("tool.listCalls requires string toolName.");
    }
    return {
        ...(payload.after === undefined ? {} : { after: payload.after }),
        ...(payload.before === undefined ? {} : { before: payload.before }),
        ...(callIds === undefined ? {} : { callIds }),
        ...(payload.ctxId === undefined ? {} : { ctxId: payload.ctxId }),
        ...(payload.includeInput === undefined
            ? {}
            : { includeInput: payload.includeInput }),
        ...(payload.includeOutput === undefined
            ? {}
            : { includeOutput: payload.includeOutput }),
        limit: readToolCallLimit(payload.limit),
        ...(payload.maxBytes === undefined
            ? {}
            : { maxBytes: readToolCallBytes(payload.maxBytes) }),
        ...(payload.source === undefined
            ? {}
            : { source: readSource(payload.source) }),
        ...(payload.status === undefined
            ? {}
            : { status: readStatus(payload.status) }),
        ...(payload.toolName === undefined
            ? {}
            : { toolName: payload.toolName }),
        ...(payload.workspace === undefined
            ? {}
            : { workspace: payload.workspace }),
    };
}

export function limitToolCallResponse(
    records: ToolCallRecord[],
    query: ToolCallQuery,
): ToolCallRecord[] {
    const newestFirst = query.after === undefined;
    const candidates = newestFirst ? [...records].reverse() : records;
    const accepted: ToolCallRecord[] = [];
    const maxBytes = Math.min(
        query.maxBytes ?? MAX_TOOL_CALL_RESPONSE_BYTES,
        MAX_TOOL_CALL_RESPONSE_BYTES,
    );
    let responseBytes = 2;
    for (const record of candidates) {
        const separatorBytes = accepted.length === 0 ? 0 : 1;
        const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
        if (responseBytes + separatorBytes + recordBytes > maxBytes) {
            if (accepted.length === 0) {
                throw invalid(
                    `tool.listCalls record ${record.callId} exceeds the safe response size.`,
                );
            }
            break;
        }
        if (newestFirst) accepted.unshift(record);
        else accepted.push(record);
        responseBytes += separatorBytes + recordBytes;
    }
    return accepted;
}

function readSource(value: JsonValue): ToolCallSource {
    if (value === "cli" || value === "tui" || value === "mcp") {
        return value;
    }
    throw invalid("tool.listCalls requires source to be cli, tui, or mcp.");
}

function readStatus(value: JsonValue): ToolCallStatus {
    if (
        value === "queued" ||
        value === "running" ||
        value === "completed" ||
        value === "failed" ||
        value === "denied" ||
        value === "queueTimeout" ||
        value === "cancelled"
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

function readToolCallBytes(value: JsonValue): number {
    return Math.min(Math.max(value as number, 1), MAX_TOOL_CALL_RESPONSE_BYTES);
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
