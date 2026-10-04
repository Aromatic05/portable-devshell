import type { DatabaseSync } from "node:sqlite";

import {
    applyDeliveredControls,
    applyQueuedControl,
    clearMessageControlStates,
    parseContextMessageDirective,
    type MessageControlState,
    normalizeMessageControlState,
    writeMessageControlState,
} from "../MessageControl.js";
import { type MessageRow, toCommentRecord } from "../store/Query.js";

const CONTROL_STATE_MIGRATION_KEY = "migration:context-control-v3";

/**
 * @compat comment-control-v3
 * @removeAt 0.7.10
 */
export function migrateMessageControlState(database: DatabaseSync): void {
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
            FROM message_entries
            ORDER BY seq ASC
        `,
        )
        .all() as unknown as MessageRow[];
    const states = deriveControlStatesFromHistory(rows);
    database.exec("BEGIN IMMEDIATE");
    try {
        clearMessageControlStates(database);
        for (const [ctxId, state] of states)
            writeMessageControlState(database, ctxId, state);
        writeMetadata(database, CONTROL_STATE_MIGRATION_KEY, "complete");
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

function deriveControlStatesFromHistory(
    rows: readonly MessageRow[],
): Map<string, MessageControlState> {
    const states = new Map<string, MessageControlState>();
    for (const row of rows) {
        const state = states.get(row.ctxId) ?? {};
        if (row.kind === "report") {
            state.pendingReplyCommentId = undefined;
            state.pendingPushCommentId = undefined;
            state.pushMessage = undefined;
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
        applyQueuedControl(state, record);
        applyDeliveredControls(state, [record]);
        if (directive === "push" && state.pendingPushCommentId === record.id) {
            state.pushToolCallsRemaining = 0;
        }
        states.set(row.ctxId, state);
    }
    for (const [ctxId, state] of states) {
        const normalized = normalizeMessageControlState(state);
        if (Object.keys(normalized).length === 0) states.delete(ctxId);
        else states.set(ctxId, normalized);
    }
    return states;
}

function readMetadata(database: DatabaseSync, key: string): string | undefined {
    const row = database
        .prepare("SELECT value FROM message_metadata WHERE key = ?")
        .get(key) as { value: string } | undefined;
    return row?.value;
}

function writeMetadata(
    database: DatabaseSync,
    key: string,
    value: string,
): void {
    database
        .prepare(
            `
            INSERT INTO message_metadata(key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        )
        .run(key, value);
}
