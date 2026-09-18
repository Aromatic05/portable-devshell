import type { DatabaseSync } from "node:sqlite";

import type {
    ContextMessageRecord,
    ConversationEntry,
    ConversationEntryKind,
    ConversationListInput,
} from "@portable-devshell/shared";

export interface ConversationRow {
    callId: string | null;
    createdAt: string;
    ctxId: string;
    deliveredAt: string | null;
    error: string | null;
    failedAt: string | null;
    id: string;
    kind: ConversationEntryKind;
    seq: number;
    status: ContextMessageRecord["status"] | null;
    text: string;
}

export function listConversationRows(
    database: DatabaseSync,
    input: Pick<ConversationListInput, "before" | "ctxId" | "limit">,
    kind: ConversationEntryKind | undefined,
): ConversationRow[] {
    const predicates: string[] = [];
    const parameters: Array<number | string> = [];
    if (kind !== undefined) {
        predicates.push("kind = ?");
        parameters.push(kind);
    }
    if (input.ctxId !== undefined) {
        predicates.push("ctx_id = ?");
        parameters.push(input.ctxId);
    }
    if (input.before !== undefined) {
        const boundary = database
            .prepare(
                `
                SELECT created_at AS createdAt, id, kind, seq
                FROM conversation_entries
                WHERE id = ? ${kind === undefined ? "" : "AND kind = ?"}
                ORDER BY created_at ASC, seq ASC
                LIMIT 1
            `,
            )
            .get(input.before, ...(kind === undefined ? [] : [kind])) as
            | {
                  createdAt: string;
                  id: string;
                  kind: ConversationEntryKind;
                  seq: number;
              }
            | undefined;
        if (boundary !== undefined) {
            predicates.push("(created_at < ? OR (created_at = ? AND seq < ?))");
            parameters.push(boundary.createdAt, boundary.createdAt, boundary.seq);
        }
    }
    const limit =
        input.limit === undefined ? undefined : Math.max(1, Math.trunc(input.limit));
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
            ${predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`}
            ORDER BY created_at DESC, seq DESC
            ${limit === undefined ? "" : "LIMIT ?"}
        `,
        )
        .all(
            ...(limit === undefined ? parameters : [...parameters, limit]),
        ) as unknown as ConversationRow[];
    return rows.reverse();
}

export function pendingCommentRecords(
    database: DatabaseSync,
    instance: string,
    ctxId?: string,
): ContextMessageRecord[] {
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
            WHERE kind = 'comment'
              AND status IN ('pending', 'sent')
              ${ctxId === undefined ? "" : "AND ctx_id = ?"}
            ORDER BY created_at ASC, seq ASC
        `,
        )
        .all(...(ctxId === undefined ? [] : [ctxId])) as unknown as ConversationRow[];
    return rows.map((row) => toCommentRecord(row, instance));
}

export function toConversationEntry(row: ConversationRow): ConversationEntry {
    return {
        ...(row.callId === null ? {} : { callId: row.callId }),
        createdAt: row.createdAt,
        ctxId: row.ctxId,
        ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
        ...(row.error === null ? {} : { error: row.error }),
        ...(row.failedAt === null ? {} : { failedAt: row.failedAt }),
        id: row.id,
        kind: row.kind,
        ...(row.status === null ? {} : { status: row.status }),
        text: row.text,
    };
}

export function toCommentRecord(
    row: ConversationRow,
    instance: string,
): ContextMessageRecord {
    if (row.kind !== "comment" || row.status === null) {
        throw new Error("Conversation row is not a Context Comment.");
    }
    return {
        ...(row.callId === null ? {} : { callId: row.callId }),
        createdAt: row.createdAt,
        ctxId: row.ctxId,
        ...(row.deliveredAt === null ? {} : { deliveredAt: row.deliveredAt }),
        ...(row.error === null ? {} : { error: row.error }),
        ...(row.failedAt === null ? {} : { failedAt: row.failedAt }),
        id: row.id,
        instance,
        status: row.status,
        text: row.text,
    };
}

export function applyByteBudget<T>(records: T[], maxBytes: number | undefined): T[] {
    if (maxBytes === undefined) return records;
    const accepted: T[] = [];
    let bytes = 2;
    for (const record of [...records].reverse()) {
        const recordBytes =
            Buffer.byteLength(JSON.stringify(record), "utf8") +
            (accepted.length === 0 ? 0 : 1);
        if (bytes + recordBytes > maxBytes) break;
        accepted.unshift(record);
        bytes += recordBytes;
    }
    return accepted;
}

export function readConversationPayloadBytes(database: DatabaseSync): number {
    const row = database
        .prepare(
            `
            SELECT COALESCE(SUM(${conversationPayloadBytesSql()}), 0) AS payloadBytes
            FROM conversation_entries
        `,
        )
        .get() as { payloadBytes: number };
    return row.payloadBytes;
}

export function readConversationEntryPayloadBytes(
    database: DatabaseSync,
    kind: ConversationEntryKind,
    id: string,
): number {
    const row = database
        .prepare(
            `
            SELECT ${conversationPayloadBytesSql()} AS payloadBytes
            FROM conversation_entries
            WHERE kind = ? AND id = ?
        `,
        )
        .get(kind, id) as { payloadBytes: number } | undefined;
    return row?.payloadBytes ?? 0;
}

export function conversationPayloadBytesSql(): string {
    return [
        "64",
        "length(CAST(kind AS BLOB))",
        "length(CAST(id AS BLOB))",
        "length(CAST(ctx_id AS BLOB))",
        "length(CAST(created_at AS BLOB))",
        "length(CAST(text AS BLOB))",
        "COALESCE(length(CAST(status AS BLOB)), 0)",
        "COALESCE(length(CAST(call_id AS BLOB)), 0)",
        "COALESCE(length(CAST(delivered_at AS BLOB)), 0)",
        "COALESCE(length(CAST(failed_at AS BLOB)), 0)",
        "COALESCE(length(CAST(error AS BLOB)), 0)",
    ].join(" + ");
}
