import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

const MAX_LOG_READ_LIMIT = 100;
const MAX_LOG_RESPONSE_BYTES = 1024 * 1024;
const LOG_TRUNCATION_MARKER = "\n[log output truncated]\n";

export function readRuntimeWorkspacePath(payload?: JsonValue): string | undefined {
    if (!isRecord(payload) || payload.workspacePath === undefined) {
        return undefined;
    }
    if (typeof payload.workspacePath !== "string") {
        throw invalid("runtime.start requires workspacePath to be a string.");
    }
    return payload.workspacePath;
}

export function readRuntimeLogQuery(payload?: JsonValue): { fromSeq?: number; limit?: number } {
    const limit = isRecord(payload) && typeof payload.limit === "number" && Number.isInteger(payload.limit)
        ? Math.min(Math.max(payload.limit, 1), MAX_LOG_READ_LIMIT)
        : MAX_LOG_READ_LIMIT;
    return {
        fromSeq: isRecord(payload) && typeof payload.fromSeq === "number" ? payload.fromSeq : undefined,
        limit
    };
}

export function readRuntimeSubscriptionFromSeq(payload?: JsonValue): number {
    if (!isRecord(payload) || typeof payload.fromSeq !== "number" || !Number.isSafeInteger(payload.fromSeq) || payload.fromSeq < 0) {
        throw invalid("runtime.subscribe requires a non-negative integer fromSeq.");
    }
    return payload.fromSeq;
}

export function limitRuntimeLogResponse<TLog extends { message: string }>(logs: TLog[]): TLog[] {
    const response: TLog[] = [];
    let responseBytes = 2;
    for (const log of logs) {
        const separatorBytes = response.length === 0 ? 0 : 1;
        const logBytes = Buffer.byteLength(JSON.stringify(log), "utf8");
        if (responseBytes + separatorBytes + logBytes <= MAX_LOG_RESPONSE_BYTES) {
            response.push(log);
            responseBytes += separatorBytes + logBytes;
            continue;
        }
        const compact = {
            ...log,
            message: truncateLogMessage(log, MAX_LOG_RESPONSE_BYTES - responseBytes - separatorBytes)
        };
        if (responseBytes + separatorBytes + Buffer.byteLength(JSON.stringify(compact), "utf8") <= MAX_LOG_RESPONSE_BYTES) {
            response.push(compact);
        }
        return response;
    }
    return response;
}

function truncateLogMessage<TLog extends { message: string }>(log: TLog, availableBytes: number): string {
    if (Buffer.byteLength(JSON.stringify({ ...log, message: LOG_TRUNCATION_MARKER }), "utf8") > availableBytes) {
        return LOG_TRUNCATION_MARKER;
    }
    let start = 0;
    let end = log.message.length;
    while (start < end) {
        const middle = Math.floor((start + end) / 2);
        const message = `${LOG_TRUNCATION_MARKER}${log.message.slice(middle)}`;
        if (Buffer.byteLength(JSON.stringify({ ...log, message }), "utf8") <= availableBytes) {
            end = middle;
        } else {
            start = middle + 1;
        }
    }
    return `${LOG_TRUNCATION_MARKER}${log.message.slice(start)}`;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string) {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}
