import { randomUUID } from "node:crypto";

import type { JsonValue, ToolCallAssociation, ToolCallContext } from "@portable-devshell/shared";

export interface WorkerInstanceToolCallScope {
    association?: ToolCallAssociation;
    callId: string;
    context: ToolCallContext;
    eventContext: {
        callId: string;
        input: JsonValue;
        inputSummary: string;
        requestId?: string;
        ctxId?: string;
        source: ToolCallContext["source"];
        taskId?: string;
        todoItemId?: string;
        toolName: string;
    };
    input: JsonValue;
    inputSummary: string;
    startedAt: string;
    toolName: string;
}

export function createWorkerInstanceToolCallScope(
    toolName: string,
    input: JsonValue,
    context: ToolCallContext,
    association?: ToolCallAssociation
): WorkerInstanceToolCallScope {
    const callId = randomUUID();
    const inputSummary = toInputSummary(input);
    const startedAt = new Date().toISOString();

    return {
        association,
        callId,
        context,
        eventContext: {
            callId,
            input,
            inputSummary,
            requestId: context.requestId,
            ctxId: context.ctxId,
            source: context.source,
            taskId: association?.taskId,
            todoItemId: association?.todoItemId,
            toolName
        },
        input,
        inputSummary,
        startedAt,
        toolName
    };
}

function toInputSummary(input: JsonValue): string {
    if (Array.isArray(input)) {
        return input.map((value) => JSON.stringify(value) ?? "null").join(" ");
    }

    if (typeof input === "object" && input !== null) {
        return JSON.stringify(input) ?? "null";
    }

    return String(input);
}
