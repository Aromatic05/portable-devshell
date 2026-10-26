import type { ExtensionDatabaseConnection } from "@portable-devshell/extension/database";

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

// Keep each SQL response within the 16 MiB Sandbox message budget.
const PAGE_ROWS = 128;

async function selectRows(
    database: ExtensionDatabaseConnection,
    sql: string,
    parameters: readonly (number | string)[],
    limit?: number,
): Promise<MessageRow[]> {
    const rows: MessageRow[] = [];
    for (;;) {
        const remaining =
            limit === undefined
                ? PAGE_ROWS
                : Math.min(PAGE_ROWS, limit - rows.length);
        if (remaining <= 0) break;
        const page = (await database.all(`${sql} LIMIT ? OFFSET ?`, [
            ...parameters,
            remaining,
            rows.length,
        ])) as unknown as MessageRow[];
        rows.push(...page);
        if (page.length < remaining) break;
    }
    return rows;
}

export async function listMessageRows(
    database: ExtensionDatabaseConnection,
    input: Pick<MessageListInput, "before" | "ctxId" | "limit">,
    kind: MessageEntryKind | undefined,
): Promise<MessageRow[]> {
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
        const boundary = (await database.get(
            `
                SELECT created_at AS createdAt, id, kind, seq
                FROM message_entries
                WHERE id = ? ${kind === undefined ? "" : "AND kind = ?"}
                    ${input.ctxId === undefined ? "" : "AND ctx_id = ?"}
                ORDER BY created_at ASC, seq ASC
                LIMIT 1
            `,
            [input.before, ...(kind === undefined ? [] : [kind]),
                ...(input.ctxId === undefined ? [] : [input.ctxId])],
        )) as
            | {
                  createdAt: string;
                  id: string;
                  kind: MessageEntryKind;
                  seq: number;
              }
            | undefined;
        if (boundary === undefined)
            throw new Error("Message history cursor is unavailable in the requested Context.");
        predicates.push("(created_at < ? OR (created_at = ? AND seq < ?))");
        parameters.push(boundary.createdAt, boundary.createdAt, boundary.seq);
    }
    const limit =
        input.limit === undefined
            ? undefined
            : Math.max(1, Math.trunc(input.limit));
    const rows = await selectRows(
        database,
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
        `,
        parameters,
        limit,
    );
    return rows.reverse();
}

export async function pendingCommentRecords(
    database: ExtensionDatabaseConnection,
    instance: string,
    ctxId?: string,
): Promise<ContextMessageRecord[]> {
    const rows = await selectRows(
        database,
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
        [...(ctxId === undefined ? [] : [ctxId])],
    );
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
        if (bytes + recordBytes > maxBytes) {
            if (accepted.length === 0)
                throw new RangeError(`Message entry exceeds maxBytes ${maxBytes}.`);
            break;
        }
        accepted.unshift(record);
        bytes += recordBytes;
    }
    return accepted;
}

export async function readMessagePayloadBytes(
    database: ExtensionDatabaseConnection,
): Promise<number> {
    const row = (await database.get(
        `
            SELECT COALESCE(SUM(${messagePayloadBytesSql()}), 0) AS payloadBytes
            FROM message_entries
        `,
        [],
    )) as { payloadBytes: number };
    return row.payloadBytes;
}

export async function readMessageEntryPayloadBytes(
    database: ExtensionDatabaseConnection,
    kind: MessageEntryKind,
    id: string,
): Promise<number> {
    const row = (await database.get(
        `
            SELECT ${messagePayloadBytesSql()} AS payloadBytes
            FROM message_entries
            WHERE kind = ? AND id = ?
        `,
        [kind, id],
    )) as { payloadBytes: number } | undefined;
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
