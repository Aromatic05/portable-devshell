export type ContextMessageStatus = "pending" | "sent" | "delivered" | "failed";

export type ContextMessageDirective = "push" | "resume" | "stop";

export const CONTEXT_MESSAGE_PUSH_TOOL_BUDGET = 5;

export interface ParsedContextMessageDirective {
    body: string;
    directive?: ContextMessageDirective;
}

export function parseContextMessageDirective(text: string): ParsedContextMessageDirective {
    const trimmed = text.trimStart();
    const match = /^#(push|stop|resume)(?:\s+|$)/u.exec(trimmed);
    if (match === null) return { body: text };
    return {
        body: trimmed.slice(match[0].length).trimStart(),
        directive: match[1] as ContextMessageDirective,
    };
}

export interface ContextMessageRecord {
    callId?: string;
    createdAt: string;
    ctxId: string;
    deliveredAt?: string;
    error?: string;
    failedAt?: string;
    id: string;
    instance: string;
    status: ContextMessageStatus;
    text: string;
}

export interface ContextMessageQueueInput {
    ctxId: string;
    text: string;
}

export interface ContextMessageListInput {
    before?: string;
    ctxId?: string;
    limit?: number;
    maxBytes?: number;
}

export interface ContextMessageReadResult {
    callId: string;
    comment?: string;
    messages: Array<Pick<ContextMessageRecord, "createdAt" | "id" | "text">>;
}
