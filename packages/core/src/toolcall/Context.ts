import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

const LIVE_INPUT_SUMMARY_MAX_LENGTH = 512;

export interface ToolCallScope {
    callId: string;
    context: ToolCallContext;
    eventContext: {
        callId: string;
        inputSummary: string;
        requestId?: string;
        ctxId?: string;
        source: ToolCallContext["source"];
        toolName: string;
        workspace?: string;
    };
    input: JsonValue;
    inputSummary: string;
    startedAt: string;
    toolName: string;
}

export function createToolCallScope(
    callId: string,
    toolName: string,
    input: JsonValue,
    context: ToolCallContext,
): ToolCallScope {
    const inputSummary = summarizeToolCallInput(input);
    const startedAt = new Date().toISOString();

    return {
        callId,
        context,
        eventContext: {
            callId,
            inputSummary,
            requestId: context.requestId,
            ctxId: context.ctxId,
            source: context.source,
            toolName,
            workspace: context.workspace,
        },
        input,
        inputSummary,
        startedAt,
        toolName,
    };
}

export function summarizeToolCallInput(input: JsonValue): string {
    const summary = serializeInput(input);
    if (summary.length <= LIVE_INPUT_SUMMARY_MAX_LENGTH) {
        return summary;
    }
    return `${summary.slice(0, LIVE_INPUT_SUMMARY_MAX_LENGTH - 1)}…`;
}

function serializeInput(input: JsonValue): string {
    if (Array.isArray(input)) {
        return input.map((value) => JSON.stringify(value) ?? "null").join(" ");
    }

    if (typeof input === "object" && input !== null) {
        return JSON.stringify(input) ?? "null";
    }

    return String(input);
}
