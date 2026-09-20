import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type {
    ContextMessageListInput,
    ContextMessageRecord,
    ConversationEntry,
    ConversationListInput,
} from "@portable-devshell/shared";

import { migrateLegacyComments } from "../migration/Comment.js";
import {
    applyDeliveredControls,
    applyQueuedControl,
    clearConversationControlStates,
    type ConversationControlState,
    readConversationControlCommentIds,
    readConversationControlState,
    writeConversationControlState,
} from "../ConversationControl.js";
import { migrateConversationControlState } from "../migration/Control.js";
import {
    completeLegacyReportMigration,
    isLegacyReportMigrationComplete,
} from "../migration/Report.js";
import {
    applyByteBudget,
    conversationPayloadBytesSql,
    listConversationRows,
    pendingCommentRecords,
    readCommentRecord,
    readConversationEntryPayloadBytes,
    readConversationPayloadBytes,
    toCommentRecord,
    toConversationEntry,
} from "./Query.js";
import {
    defaultConversationStorageLimits,
    openConversationDatabase,
} from "./Schema.js";

export {
    defaultConversationStorageLimits,
} from "./Schema.js";
export type { ConversationControlState } from "../ConversationControl.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface ConversationStoreStats {
    comments: number;
    entries: number;
    fileBytes: number;
    maxBytes: number;
    payloadBytes: number;
    protectedComments: number;
    reports: number;
    retentionDays: number;
}

export class ConversationStore {
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #legacyContextMessagesFile?: string;
    readonly #maxBytes: number;
    readonly #now: () => number;
    readonly #retentionDays: number;
    readonly #retentionMs: number;
    #database?: DatabaseSync;
    #lastRetentionCleanupAt = Number.NEGATIVE_INFINITY;
    #payloadBytes?: number;

    constructor(options: {
        filePath: string;
        instanceName: string;
        legacyContextMessagesFile?: string;
        maxBytes?: number;
        now?: () => number;
        retentionDays?: number;
    }) {
        const maxBytes =
            options.maxBytes ?? defaultConversationStorageLimits.maxBytes;
        const retentionDays =
            options.retentionDays ??
            defaultConversationStorageLimits.retentionDays;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
            throw new TypeError(
                "Conversation maxBytes must be a positive safe integer.",
            );
        }
        if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
            throw new TypeError(
                "Conversation retentionDays must be a positive safe integer.",
            );
        }
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#legacyContextMessagesFile = options.legacyContextMessagesFile;
        this.#maxBytes = maxBytes;
        this.#now = options.now ?? Date.now;
        this.#retentionDays = retentionDays;
        this.#retentionMs = retentionDays * DAY_MS;
    }

    close(): void {
        this.#database?.close();
        this.#database = undefined;
        this.#lastRetentionCleanupAt = Number.NEGATIVE_INFINITY;
        this.#payloadBytes = undefined;
    }

    list(input: ConversationListInput = {}): ConversationEntry[] {
        const database = this.#open();
        this.#cleanup(database);
        return applyByteBudget(
            listConversationRows(database, input, undefined).map(toConversationEntry),
            input.maxBytes,
        );
    }

    listComments(input: ContextMessageListInput = {}): ContextMessageRecord[] {
        const database = this.#open();
        this.#cleanup(database);
        return applyByteBudget(
            listConversationRows(database, input, "comment").map((row) =>
                toCommentRecord(row, this.#instanceName),
            ),
            input.maxBytes,
        );
    }

    pendingComments(ctxId?: string): ContextMessageRecord[] {
        return pendingCommentRecords(this.#open(), this.#instanceName, ctxId);
    }

    comment(ctxId: string, id: string): ContextMessageRecord | undefined {
        return readCommentRecord(this.#open(), this.#instanceName, ctxId, id);
    }

    insertComment(record: ContextMessageRecord): void {
        const database = this.#open();
        database.exec("BEGIN IMMEDIATE");
        try {
            database
                .prepare(
                    `
                INSERT INTO conversation_entries(
                    kind, id, ctx_id, created_at, text, status, call_id, delivered_at, failed_at, error
                ) VALUES ('comment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
                )
                .run(
                    record.id,
                    record.ctxId,
                    record.createdAt,
                    record.text,
                    record.status,
                    record.callId ?? null,
                    record.deliveredAt ?? null,
                    record.failedAt ?? null,
                    record.error ?? null,
                );
            const state = readConversationControlState(
                database,
                record.ctxId,
            );
            if (record.status === "delivered")
                applyDeliveredControls(state, [record]);
            else if (record.status === "pending" || record.status === "sent")
                applyQueuedControl(state, record);
            writeConversationControlState(database, record.ctxId, state);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        this.#payloadBytes =
            this.#trackedPayloadBytes() +
            readConversationEntryPayloadBytes(database, "comment", record.id);
        this.#cleanup(
            database,
            record.status === "delivered" || record.status === "failed",
        );
    }

    readControlState(ctxId: string): ConversationControlState {
        return readConversationControlState(this.#open(), ctxId);
    }

    writeControlState(ctxId: string, state: ConversationControlState): void {
        const database = this.#open();
        database.exec("BEGIN IMMEDIATE");
        try {
            writeConversationControlState(database, ctxId, state);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
    }

    clearAllControlStates(): void {
        clearConversationControlStates(this.#open());
    }

    deliverComments(
        ctxId: string,
        callId: string,
        deliveredAt: string,
    ): ContextMessageRecord[] {
        const database = this.#open();
        let pending: ContextMessageRecord[] = [];
        let beforePayloadBytes = 0;
        database.exec("BEGIN IMMEDIATE");
        try {
            pending = this.pendingComments(ctxId);
            if (pending.length === 0) {
                database.exec("COMMIT");
                return [];
            }
            beforePayloadBytes = pending.reduce(
                (total, record) =>
                    total +
                    readConversationEntryPayloadBytes(database, "comment", record.id),
                0,
            );
            const update = database.prepare(`
                UPDATE conversation_entries
                SET status = 'delivered', call_id = ?, delivered_at = ?, failed_at = NULL, error = NULL
                WHERE kind = 'comment' AND id = ?
            `);
            for (const record of pending)
                update.run(callId, deliveredAt, record.id);
            const state = readConversationControlState(database, ctxId);
            applyDeliveredControls(state, pending);
            writeConversationControlState(database, ctxId, state);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        const afterPayloadBytes = pending.reduce(
            (total, record) =>
                total +
                readConversationEntryPayloadBytes(database, "comment", record.id),
            0,
        );
        this.#payloadBytes =
            this.#trackedPayloadBytes() +
            afterPayloadBytes -
            beforePayloadBytes;
        this.#cleanup(database, true);
        return pending.map((record) => ({
            ...record,
            callId,
            deliveredAt,
            error: undefined,
            failedAt: undefined,
            status: "delivered" as const,
        }));
    }

    failComments(
        ids: ReadonlySet<string>,
        error: string,
        failedAt: string,
    ): void {
        if (ids.size === 0) return;
        const database = this.#open();
        const failedRecords = this.listComments().filter((record) =>
            ids.has(record.id),
        );
        const beforePayloadBytes = [...ids].reduce(
            (total, id) =>
                total + readConversationEntryPayloadBytes(database, "comment", id),
            0,
        );
        database.exec("BEGIN IMMEDIATE");
        try {
            const update = database.prepare(`
                UPDATE conversation_entries
                SET status = 'failed', delivered_at = NULL, failed_at = ?, error = ?
                WHERE kind = 'comment' AND id = ?
            `);
            for (const id of ids) update.run(failedAt, error, id);
            for (const ctxId of new Set(
                failedRecords.map((record) => record.ctxId),
            )) {
                const state = readConversationControlState(
                    database,
                    ctxId,
                );
                if (
                    state.stoppedByCommentId !== undefined &&
                    ids.has(state.stoppedByCommentId)
                ) {
                    state.stoppedByCommentId = undefined;
                }
                if (
                    state.pendingResumeCommentId !== undefined &&
                    ids.has(state.pendingResumeCommentId)
                ) {
                    state.pendingResumeCommentId = undefined;
                }
                writeConversationControlState(database, ctxId, state);
            }
            database.exec("COMMIT");
        } catch (cause) {
            database.exec("ROLLBACK");
            throw cause;
        }
        const afterPayloadBytes = [...ids].reduce(
            (total, id) =>
                total + readConversationEntryPayloadBytes(database, "comment", id),
            0,
        );
        this.#payloadBytes =
            this.#trackedPayloadBytes() +
            afterPayloadBytes -
            beforePayloadBytes;
        this.#cleanup(database, true);
    }

    appendReport(input: {
        callId: string;
        createdAt: string;
        ctxId: string;
        replyCommentId?: string;
        text: string;
    }): void {
        const database = this.#open();
        database.exec("BEGIN IMMEDIATE");
        let changes = 0;
        try {
            const result = database
                .prepare(
                    `
                INSERT INTO conversation_entries(kind, id, ctx_id, created_at, text, call_id)
                VALUES ('report', ?, ?, ?, ?, ?)
                ON CONFLICT(kind, id) DO NOTHING
            `,
                )
                .run(
                    input.callId,
                    input.ctxId,
                    input.createdAt,
                    input.text,
                    input.callId,
                );
            changes = Number(result.changes);
            if (input.replyCommentId !== undefined) {
                const state = readConversationControlState(
                    database,
                    input.ctxId,
                );
                if (state.pendingReplyCommentId === input.replyCommentId) {
                    state.pendingReplyCommentId = undefined;
                    state.pendingPushCommentId = undefined;
                    state.pushToolCallsRemaining = undefined;
                }
                writeConversationControlState(database, input.ctxId, state);
            }
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        if (changes > 0) {
            this.#payloadBytes =
                this.#trackedPayloadBytes() +
                readConversationEntryPayloadBytes(database, "report", input.callId);
        }
        this.#cleanup(database, true);
    }

    stats(): ConversationStoreStats {
        const database = this.#open();
        this.#cleanup(database);
        const row = database
            .prepare(
                `
            SELECT
                COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN kind = 'comment' THEN 1 ELSE 0 END), 0) AS comments,
                COALESCE(SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END), 0) AS reports,
                COALESCE(SUM(CASE WHEN kind = 'comment' AND status IN ('pending', 'sent') THEN 1 ELSE 0 END), 0) AS protectedComments
            FROM conversation_entries
        `,
            )
            .get() as {
            comments: number;
            entries: number;
            protectedComments: number;
            reports: number;
        };
        return {
            comments: row.comments,
            entries: row.entries,
            fileBytes:
                fileSize(this.#filePath) + fileSize(`${this.#filePath}-wal`),
            maxBytes: this.#maxBytes,
            payloadBytes: this.#trackedPayloadBytes(),
            protectedComments: row.protectedComments,
            reports: row.reports,
            retentionDays: this.#retentionDays,
        };
    }

    isLegacyReportMigrationComplete(): boolean {
        return isLegacyReportMigrationComplete(this.#open());
    }

    completeLegacyReportMigration(): void {
        completeLegacyReportMigration(this.#open());
    }

    #open(): DatabaseSync {
        if (this.#database !== undefined) return this.#database;
        const database = openConversationDatabase(this.#filePath);
        try {
            this.#database = database;
            migrateLegacyComments(database, this.#legacyContextMessagesFile);
            migrateConversationControlState(database);
            this.#payloadBytes = readConversationPayloadBytes(database);
            this.#cleanup(database, true);
            return database;
        } catch (error) {
            this.#database = undefined;
            database.close();
            throw error;
        }
    }

    #cleanup(database: DatabaseSync, forceRetention = false): void {
        const now = this.#now();
        let removed = false;
        const protectedCommentIds = [
            ...readConversationControlCommentIds(database),
        ];
        const protectedCommentClause =
            protectedCommentIds.length === 0
                ? ""
                : `AND id NOT IN (${protectedCommentIds.map(() => "?").join(", ")})`;
        if (
            forceRetention ||
            now - this.#lastRetentionCleanupAt >= RETENTION_CLEANUP_INTERVAL_MS
        ) {
            const cutoff = new Date(now - this.#retentionMs).toISOString();
            const expired = database
                .prepare(
                    `
                SELECT COUNT(*) AS entries, COALESCE(SUM(${conversationPayloadBytesSql()}), 0) AS payloadBytes
                FROM conversation_entries
                WHERE
                    (kind = 'report' AND created_at < ?)
                    OR (
                        kind = 'comment'
                        AND status IN ('delivered', 'failed')
                        AND COALESCE(delivered_at, failed_at, created_at) < ?
                        ${protectedCommentClause}
                    )
            `,
                )
                .get(cutoff, cutoff, ...protectedCommentIds) as {
                entries: number;
                payloadBytes: number;
            };
            if (expired.entries > 0) {
                database
                    .prepare(
                        `
                    DELETE FROM conversation_entries
                    WHERE
                        (kind = 'report' AND created_at < ?)
                        OR (
                            kind = 'comment'
                            AND status IN ('delivered', 'failed')
                            AND COALESCE(delivered_at, failed_at, created_at) < ?
                            ${protectedCommentClause}
                        )
                `,
                    )
                    .run(cutoff, cutoff, ...protectedCommentIds);
                this.#payloadBytes = Math.max(
                    0,
                    this.#trackedPayloadBytes() - expired.payloadBytes,
                );
                removed = true;
            }
            this.#lastRetentionCleanupAt = now;
        }

        while (this.#trackedPayloadBytes() > this.#maxBytes) {
            const candidates = database
                .prepare(
                    `
                SELECT seq, ${conversationPayloadBytesSql()} AS payloadBytes
                FROM conversation_entries
                WHERE kind = 'report' OR (
                    kind = 'comment'
                    AND status IN ('delivered', 'failed')
                    ${protectedCommentClause}
                )
                ORDER BY
                    CASE
                        WHEN kind = 'report' THEN created_at
                        ELSE COALESCE(delivered_at, failed_at, created_at)
                    END ASC,
                    seq ASC
                LIMIT 256
            `,
                )
                .all(...protectedCommentIds) as Array<{
                payloadBytes: number;
                seq: number;
            }>;
            if (candidates.length === 0) break;
            const remove = database.prepare(
                "DELETE FROM conversation_entries WHERE seq = ?",
            );
            let payloadBytes = this.#trackedPayloadBytes();
            database.exec("BEGIN IMMEDIATE");
            try {
                for (const candidate of candidates) {
                    if (payloadBytes <= this.#maxBytes) break;
                    remove.run(candidate.seq);
                    payloadBytes -= candidate.payloadBytes;
                    removed = true;
                }
                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
            this.#payloadBytes = Math.max(0, payloadBytes);
        }

        if (removed && this.#trackedPayloadBytes() <= this.#maxBytes) {
            const fileBytes =
                fileSize(this.#filePath) + fileSize(`${this.#filePath}-wal`);
            if (fileBytes > this.#maxBytes) {
                database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
                if (fileSize(this.#filePath) > this.#maxBytes)
                    database.exec("VACUUM");
            }
        }
    }

    #trackedPayloadBytes(): number {
        if (this.#payloadBytes === undefined) {
            throw new Error(
                "Conversation payload accounting is not initialized.",
            );
        }
        return this.#payloadBytes;
    }

}

function fileSize(path: string): number {
    try {
        return statSync(path).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
    }
}
