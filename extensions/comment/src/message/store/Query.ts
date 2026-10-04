import type { DatabaseSync } from "node:sqlite";

import type {
    ContextMessageRecord,
    MessageEntry,
    MessageEntryKind,
    MessageListInput,
} from "@portable-devshell/shared";

export interface MessageRow {
    callId: string | null;
    createdAt: string;
    ctxId: string;
    deliveredAt: string | null;
    error: string | null;
    failedAt: string | null;
    id: string;
    kind: MessageEntryKind;
    seq: number;
    status: ContextMessageRecord["status"] | null;
    text: string;
}

export function listMessageRows(
    database: DatabaseSync,
    input: Pick<MessageListInput, "before" | "ctxId" | "limit">,
    kind: MessageEntryKind | undefined,
): MessageRow[] {
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
                FROM message_entries
                WHERE id = ? ${kind === undefined ? "" : "AND kind = ?"}
                ORDER BY created_at ASC, seq ASC
                LIMIT 1
            `,
            )
            .get(input.before, ...(kind === undefined ? [] : [kind])) as
            | {
                  createdAt: string;
                  id: string;
                  kind: MessageEntryKind;
                  seq: number;
              }
            | undefined;
        if (boundary !== undefined) {
            predicates.push("(created_at < ? OR (created_at = ? AND seq < ?))");
            parameters.push(
                boundary.createdAt,
                boundary.createdAt,
                boundary.seq,
            );
        }
    }
    const limit =
        input.limit === undefined
            ? undefined
            : Math.max(1, Math.trunc(input.limit));
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
            ${predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`}
            ORDER BY created_at DESC, seq DESC
            ${limit === undefined ? "" : "LIMIT ?"}
        `,
        )
        .all(
            ...(limit === undefined ? parameters : [...parameters, limit]),
        ) as unknown as MessageRow[];
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
            FROM message_entries
            WHERE kind = 'comment'
              AND status IN ('pending', 'sent')
              ${ctxId === undefined ? "" : "AND ctx_id = ?"}
            ORDER BY created_at ASC, seq ASC
        `,
        )
        .all(
            ...(ctxId === undefined ? [] : [ctxId]),
        ) as unknown as MessageRow[];
    return rows.map((row) => toCommentRecord(row, instance));
}

export function toMessageEntry(row: MessageRow): MessageEntry {
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
    row: MessageRow,
    instance: string,
): ContextMessageRecord {
    if (row.kind !== "comment" || row.status === null) {
        throw new Error("Message row is not a Context Comment.");
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

export function applyByteBudget<T>(
    records: T[],
    maxBytes: number | undefined,
): T[] {
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

export function readMessagePayloadBytes(database: DatabaseSync): number {
    const row = database
        .prepare(
            `
            SELECT COALESCE(SUM(${messagePayloadBytesSql()}), 0) AS payloadBytes
            FROM message_entries
        `,
        )
        .get() as { payloadBytes: number };
    return row.payloadBytes;
}

export function readMessageEntryPayloadBytes(
    database: DatabaseSync,
    kind: MessageEntryKind,
    id: string,
): number {
    const row = database
        .prepare(
            `
            SELECT ${messagePayloadBytesSql()} AS payloadBytes
            FROM message_entries
            WHERE kind = ? AND id = ?
        `,
        )
        .get(kind, id) as { payloadBytes: number } | undefined;
    return row?.payloadBytes ?? 0;
}

export function messagePayloadBytesSql(): string {
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
