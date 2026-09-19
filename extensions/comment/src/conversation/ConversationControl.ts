import type { DatabaseSync } from "node:sqlite";

import type { ContextMessageRecord } from "@portable-devshell/shared";
import {
    CONTEXT_MESSAGE_PUSH_TOOL_BUDGET,
    parseContextMessageDirective,
} from "@portable-devshell/shared";

export const CONTROL_STATE_METADATA_PREFIX = "context-control:v1:";

export interface ConversationControlState {
    pendingPushCommentId?: string;
    pendingReplyCommentId?: string;
    pendingResumeCommentId?: string;
    pushToolCallsRemaining?: number;
    stoppedByCommentId?: string;
}

export function readConversationControlState(
    database: DatabaseSync,
    ctxId: string,
): ConversationControlState {
    const row = database
        .prepare("SELECT value FROM conversation_metadata WHERE key = ?")
        .get(controlStateMetadataKey(ctxId)) as { value: string } | undefined;
    if (row === undefined) return {};
    return normalizeConversationControlState(JSON.parse(row.value) as unknown);
}

export function writeConversationControlState(
    database: DatabaseSync,
    ctxId: string,
    state: ConversationControlState,
): void {
    const normalized = normalizeConversationControlState(state);
    const key = controlStateMetadataKey(ctxId);
    if (Object.keys(normalized).length === 0) {
        database
            .prepare("DELETE FROM conversation_metadata WHERE key = ?")
            .run(key);
        return;
    }
    database
        .prepare(
            `
            INSERT INTO conversation_metadata(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        )
        .run(key, JSON.stringify(normalized));
}

export function clearConversationControlStates(database: DatabaseSync): void {
    database
        .prepare("DELETE FROM conversation_metadata WHERE key LIKE ?")
        .run(`${CONTROL_STATE_METADATA_PREFIX}%`);
}

export function applyQueuedControl(
    state: ConversationControlState,
    record: ContextMessageRecord,
): void {
    const directive = parseContextMessageDirective(record.text).directive;
    if (directive === "stop") {
        state.stoppedByCommentId ??= record.id;
        state.pendingResumeCommentId = undefined;
    } else if (
        directive === "resume" &&
        state.stoppedByCommentId !== undefined
    ) {
        state.pendingResumeCommentId = record.id;
    }
}

export function applyDeliveredControls(
    state: ConversationControlState,
    records: readonly ContextMessageRecord[],
): void {
    for (const record of records) {
        const directive = parseContextMessageDirective(record.text).directive;
        switch (directive) {
            case "stop":
                state.stoppedByCommentId ??= record.id;
                state.pendingResumeCommentId = undefined;
                break;
            case "resume":
                state.stoppedByCommentId = undefined;
                state.pendingResumeCommentId = undefined;
                state.pendingReplyCommentId = record.id;
                break;
            case "push":
                if (state.pendingReplyCommentId !== undefined) {
                    state.pendingPushCommentId = record.id;
                    state.pushToolCallsRemaining ??=
                        CONTEXT_MESSAGE_PUSH_TOOL_BUDGET;
                }
                break;
            default:
                state.pendingReplyCommentId = record.id;
                break;
        }
    }
}

export function normalizeConversationControlState(
    value: unknown,
): ConversationControlState {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("conversation control state must be an object");
    }
    const state = value as Record<string, unknown>;
    const remaining = state.pushToolCallsRemaining;
    if (
        remaining !== undefined &&
        (!Number.isSafeInteger(remaining) || (remaining as number) < 0)
    ) {
        throw new Error("conversation control push budget is invalid");
    }
    return {
        ...(typeof state.pendingPushCommentId === "string"
            ? { pendingPushCommentId: state.pendingPushCommentId }
            : {}),
        ...(typeof state.pendingReplyCommentId === "string"
            ? { pendingReplyCommentId: state.pendingReplyCommentId }
            : {}),
        ...(typeof state.pendingResumeCommentId === "string"
            ? { pendingResumeCommentId: state.pendingResumeCommentId }
            : {}),
        ...(remaining === undefined
            ? {}
            : { pushToolCallsRemaining: remaining as number }),
        ...(typeof state.stoppedByCommentId === "string"
            ? { stoppedByCommentId: state.stoppedByCommentId }
            : {}),
    };
}

function controlStateMetadataKey(ctxId: string): string {
    return `${CONTROL_STATE_METADATA_PREFIX}${ctxId}`;
}
