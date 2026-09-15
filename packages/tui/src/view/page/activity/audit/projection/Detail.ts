import {
    formatJsonSummary,
    formatJsonValue,
    parseJsonFallback,
    resolveToolOutput,
    type JsonValue,
} from "@portable-devshell/shared";

interface AuditLinkedLog {
    callId?: string;
    ctxId?: string;
    message?: string;
    stream: "stderr" | "stdout";
}

export function resolveAuditCtxId(
    ctxId: string | undefined,
    logs: readonly AuditLinkedLog[],
    callId: string,
): string | undefined {
    return ctxId ?? logs.find((entry) =>
        entry.callId === callId && entry.ctxId !== undefined
    )?.ctxId;
}

export function resolveAuditOutput(
    output: JsonValue | undefined,
    logs: readonly AuditLinkedLog[],
    callId: string,
): JsonValue | undefined {
    return resolveToolOutput(
        output,
        callId,
        logs.map((entry) => ({ ...entry, message: entry.message ?? "" })),
    );
}

export function auditInputText(input: JsonValue | undefined, fallback: string | undefined): string {
    return formatJsonValue(input ?? parseJsonFallback(fallback));
}

export function auditInputSummary(input: JsonValue | undefined, fallback: string | undefined): string {
    return formatJsonSummary(input ?? parseJsonFallback(fallback));
}

export function auditOutputText(output: JsonValue | undefined): string {
    return formatJsonValue(output ?? "-");
}

export function auditOutputSummary(output: JsonValue | undefined): string {
    return formatJsonSummary(output ?? "-");
}
