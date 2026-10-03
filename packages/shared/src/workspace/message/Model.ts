import { type InstanceEvent } from "../../execution/process/Event.js";

export type ContextMessageStatus = "pending" | "sent" | "delivered" | "failed";
export type ContextMessageDirective = "push" | "resume" | "stop";
export const CONTEXT_MESSAGE_PUSH_TOOL_BUDGET = 5;
interface ParsedContextMessageDirective {
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
export type ConversationEntryKind = "comment" | "report";
export interface ConversationEntry {
    callId?: string;
    createdAt: string;
    ctxId: string;
    deliveredAt?: string;
    error?: string;
    failedAt?: string;
    id: string;
    kind: ConversationEntryKind;
    status?: ContextMessageStatus;
    text: string;
}
export interface ConversationListInput {
    before?: string;
    ctxId?: string;
    limit?: number;
    maxBytes?: number;
}
export interface ConversationListResult {
    entries: ConversationEntry[];
    /** Instance event sequence at read time. Subscribe from lastSeq + 1. */
    lastSeq: number;
}
/**
 * Conversation identity semantics shared by every interaction surface. These
 * are domain rules (prefer the workspace folder over an opaque Context id), not
 * UI formatting such as relative time.
 */
export function compactContextId(ctxId: string, prefixLength = 12): string {
    return ctxId.length <= prefixLength + 4
        ? ctxId
        : `${ctxId.slice(0, prefixLength)}…`;
}
export function humanConversationTitle(
    input: {
        ctxId: string;
        workspace?: string;
    },
    contextPrefixLength = 12,
): string {
    return input.workspace === undefined || input.workspace.length === 0
        ? compactContextId(input.ctxId, contextPrefixLength)
        : workspaceFolderName(input.workspace);
}
/**
 * Conversation projection. Merges a freshly observed Conversation entry,
 * keeping the newest identity while preserving messages that are still in
 * flight (`pending`/`sent`) when a server list no longer reports them.
 */
export function mergeConversationEntry(
    current: readonly ConversationEntry[],
    incoming: ConversationEntry,
): ConversationEntry[] {
    return [
        ...current.filter(
            (entry) =>
                !(entry.kind === incoming.kind && entry.id === incoming.id),
        ),
        incoming,
    ].sort(
        (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
    );
}
export function mergeConversationEntryList(
    current: readonly ConversationEntry[],
    incoming: readonly ConversationEntry[],
): ConversationEntry[] {
    let result = [...current];
    for (const entry of incoming)
        result = mergeConversationEntry(result, entry);
    const incomingKeys = new Set(
        incoming.map((entry) => `${entry.kind}:${entry.id}`),
    );
    return result.filter(
        (entry) =>
            incomingKeys.has(`${entry.kind}:${entry.id}`) ||
            (entry.kind === "comment" &&
                (entry.status === "pending" || entry.status === "sent")),
    );
}
/** Instance activity events that change the Conversation projection. */
export function isConversationEvent(event: InstanceEvent): boolean {
    if (event.type.startsWith("context.message.")) return true;
    return (
        event.type === "toolCall.completed" &&
        isRecord(event.data) &&
        event.data.toolName === "todo_report"
    );
}
function workspaceFolderName(workspace: string): string {
    const normalized = workspace.replace(/[\\/]+$/u, "");
    if (normalized.length === 0) return workspace;
    return normalized.split(/[\\/]/u).at(-1) || workspace;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
