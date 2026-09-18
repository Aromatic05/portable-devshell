import type { DatabaseSync } from "node:sqlite";

import { parseContextMessageDirective } from "@portable-devshell/shared";

import {
    applyDeliveredControls,
    applyQueuedControl,
    clearConversationControlStates,
    type ConversationControlState,
    normalizeConversationControlState,
    writeConversationControlState,
} from "../ConversationControl.js";
import {
    type ConversationRow,
    toCommentRecord,
} from "../store/Query.js";

const CONTROL_STATE_MIGRATION_KEY = "migration:context-control-v1";

export function migrateConversationControlState(database: DatabaseSync): void {
    if (readMetadata(database, CONTROL_STATE_MIGRATION_KEY) === "complete")
        return;
    const rows = database
        .prepare(
            `
            SELECT
                call_id AS callId,
                created_at AS createdAt,
                ctx_id AS ctxId,
                delivered_at AS deliveredAt,
                error,
                failed_at AS failedAt,
                id,
                kind,
                seq,
                status,
                text
            FROM conversation_entries
            ORDER BY seq ASC
        `,
        )
        .all() as unknown as ConversationRow[];
    const states = deriveControlStatesFromHistory(rows);
    database.exec("BEGIN IMMEDIATE");
    try {
        clearConversationControlStates(database);
        for (const [ctxId, state] of states)
            writeConversationControlState(database, ctxId, state);
        writeMetadata(database, CONTROL_STATE_MIGRATION_KEY, "complete");
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

function deriveControlStatesFromHistory(
    rows: readonly ConversationRow[],
): Map<string, ConversationControlState> {
    const states = new Map<string, ConversationControlState>();
    for (const row of rows) {
        const state = states.get(row.ctxId) ?? {};
        if (row.kind === "report") {
            state.pendingReplyCommentId = undefined;
            state.pendingPushCommentId = undefined;
            state.pushToolCallsRemaining = undefined;
            states.set(row.ctxId, state);
            continue;
        }
        if (row.status === "failed" || row.status === null) continue;
        const record = toCommentRecord(row, "migration");
        if (row.status === "pending" || row.status === "sent") {
            applyQueuedControl(state, record);
            states.set(row.ctxId, state);
            continue;
        }
        const directive = parseContextMessageDirective(record.text).directive;
        applyDeliveredControls(state, [record]);
        if (directive === "push") state.pushToolCallsRemaining = 0;
        states.set(row.ctxId, state);
    }
    for (const [ctxId, state] of states) {
        const normalized = normalizeConversationControlState(state);
        if (Object.keys(normalized).length === 0) states.delete(ctxId);
        else states.set(ctxId, normalized);
    }
    return states;
}

function readMetadata(database: DatabaseSync, key: string): string | undefined {
    const row = database
        .prepare("SELECT value FROM conversation_metadata WHERE key = ?")
        .get(key) as { value: string } | undefined;
    return row?.value;
}

function writeMetadata(database: DatabaseSync, key: string, value: string): void {
    database
        .prepare(
            `
            INSERT INTO conversation_metadata(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        )
        .run(key, value);
}
