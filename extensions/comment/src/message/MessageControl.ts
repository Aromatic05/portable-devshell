import type { ExtensionDatabaseConnection } from "@portable-devshell/extension/database";

import type { ContextMessageRecord } from "@portable-devshell/shared";

export const CONTROL_STATE_METADATA_PREFIX = "context-control:v1:";
export const CONTEXT_MESSAGE_PUSH_TOOL_BUDGET = 5;

export function parseContextMessageDirective(text: string): {
    body: string;
    directive?: "push" | "resume" | "stop";
} {
    const trimmed = text.trimStart();
    const match = /^#(push|stop|resume)(?:\s+|$)/u.exec(trimmed);
    if (match === null) return { body: text };
    return {
        body: trimmed.slice(match[0].length).trimStart(),
        directive: match[1] as "push" | "resume" | "stop",
    };
}

export interface MessageControlState {
    pendingPushCommentId?: string;
    pendingReplyCommentId?: string;
    pendingResumeCommentId?: string;
    pushMessage?: string;
    pushToolCallsRemaining?: number;
    stoppedByCommentId?: string;
}

export async function readMessageControlState(
    database: ExtensionDatabaseConnection,
    ctxId: string,
): Promise<MessageControlState> {
    const row = (await database.get(
        "SELECT value FROM message_metadata WHERE key = ?",
        [controlStateMetadataKey(ctxId)],
    )) as { value: string } | undefined;
    if (row === undefined) return {};
    return normalizeMessageControlState(JSON.parse(row.value) as unknown);
}

export async function writeMessageControlState(
    database: ExtensionDatabaseConnection,
    ctxId: string,
    state: MessageControlState,
): Promise<void> {
    const normalized = normalizeMessageControlState(state);
    const key = controlStateMetadataKey(ctxId);
    if (Object.keys(normalized).length === 0) {
        await database.run("DELETE FROM message_metadata WHERE key = ?", [key]);
        return;
    }
    await database.run(
        `
            INSERT INTO message_metadata(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        [key, JSON.stringify(normalized)],
    );
}

export async function clearMessageControlStates(
    database: ExtensionDatabaseConnection,
): Promise<void> {
    await database.run("DELETE FROM message_metadata WHERE key LIKE ?", [
        `${CONTROL_STATE_METADATA_PREFIX}%`,
    ]);
}

export async function readMessageControlCommentIds(
    database: ExtensionDatabaseConnection,
): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    for (let offset = 0; ; offset += 128) {
        const rows = (await database.all(
            "SELECT value FROM message_metadata WHERE key LIKE ? ORDER BY key LIMIT 128 OFFSET ?",
            [`${CONTROL_STATE_METADATA_PREFIX}%`, offset],
        )) as Array<{ value: string }>;
        for (const row of rows) {
            const state = normalizeMessageControlState(
                JSON.parse(row.value) as unknown,
            );
            for (const id of [
                state.pendingPushCommentId,
                state.pendingReplyCommentId,
                state.pendingResumeCommentId,
                state.stoppedByCommentId,
            ]) {
                if (id !== undefined) ids.add(id);
            }
        }
        if (rows.length < 128) break;
    }
    return ids;
}

export function applyQueuedControl(
    state: MessageControlState,
    record: ContextMessageRecord,
): void {
    const directive = parseContextMessageDirective(record.text).directive;
    const pushActive = state.pushMessage !== undefined;
    if (pushActive) {
        state.pushMessage = `${state.pushMessage}\n\n${record.text}`;
        state.pushToolCallsRemaining = Math.max(
            0,
            (state.pushToolCallsRemaining ?? CONTEXT_MESSAGE_PUSH_TOOL_BUDGET) -
                1,
        );
    } else if (directive === "push") {
        state.pushMessage = record.text;
        state.pushToolCallsRemaining = CONTEXT_MESSAGE_PUSH_TOOL_BUDGET;
    }
    if (directive === "push") state.pendingPushCommentId = record.id;

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
    state: MessageControlState,
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
                break;
            default:
                state.pendingReplyCommentId = record.id;
                break;
        }
    }
}

export function normalizeMessageControlState(
    value: unknown,
): MessageControlState {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("message control state must be an object");
    }
    const state = value as Record<string, unknown>;
    const remaining = state.pushToolCallsRemaining;
    if (
        remaining !== undefined &&
        (!Number.isSafeInteger(remaining) || (remaining as number) < 0)
    ) {
        throw new Error("message control push budget is invalid");
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
        ...(typeof state.pushMessage === "string"
            ? { pushMessage: state.pushMessage }
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
