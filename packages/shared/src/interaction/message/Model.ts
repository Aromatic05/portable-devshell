/**
 * Context message model.
 *
 * Owns the message record queued to a Context, its delivery status, directive
 * parsing, and the pure merge semantics used when authoritative message reads
 * are folded into the projection. The message domain does not depend on the
 * Conversation subdomain: message reads are authoritative for Context messages,
 * and Conversation comment events reach this projection only through the shared
 * instance event stream.
 */

import type { InstanceEvent } from "../../runtime/activity/Model.js";

export type ContextMessageStatus = "pending" | "sent" | "delivered" | "failed";

export type ContextMessageDirective = "push" | "resume" | "stop";

export const CONTEXT_MESSAGE_PUSH_TOOL_BUDGET = 5;

export interface ParsedContextMessageDirective {
    body: string;
    directive?: ContextMessageDirective;
}

export function parseContextMessageDirective(
    text: string,
): ParsedContextMessageDirective {
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

export interface ContextMessageListResult {
    /** Instance event sequence at read time. Subscribe from lastSeq + 1. */
    lastSeq: number;
    messages: ContextMessageRecord[];
}

export interface ContextMessageReadResult {
    callId: string;
    comment?: string;
    messages: Array<Pick<ContextMessageRecord, "createdAt" | "id" | "text">>;
}

/** Instance activity events that change the Context message projection. */
export function isContextMessageEvent(event: InstanceEvent): boolean {
    return event.type.startsWith("context.message.");
}

/**
 * Message projection. Status only ever advances, so an out-of-order event
 * cannot regress a delivered/failed message back to pending.
 */
export function mergeContextMessage(
    current: readonly ContextMessageRecord[],
    incoming: ContextMessageRecord,
): ContextMessageRecord[] {
    const existing = current.find((message) => message.id === incoming.id);
    const resolved =
        existing === undefined ||
        statusRank(incoming.status) >= statusRank(existing.status)
            ? incoming
            : existing;
    return [
        ...current.filter((message) => message.id !== incoming.id),
        resolved,
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function mergeContextMessageList(
    current: readonly ContextMessageRecord[],
    incoming: readonly ContextMessageRecord[],
): ContextMessageRecord[] {
    let result = [...current];
    for (const message of incoming)
        result = mergeContextMessage(result, message);
    const incomingIds = new Set(incoming.map((message) => message.id));
    return result.filter(
        (message) =>
            incomingIds.has(message.id) ||
            message.status === "pending" ||
            message.status === "sent",
    );
}

function statusRank(status: ContextMessageStatus): number {
    switch (status) {
        case "pending":
            return 0;
        case "sent":
            return 1;
        case "delivered":
            return 2;
        case "failed":
            return 2;
    }
}