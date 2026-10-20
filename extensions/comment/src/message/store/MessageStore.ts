import { statSync } from "node:fs";
import type { ExtensionDatabaseConnection } from "@portable-devshell/extension/database";

import type {
    ContextMessageListInput,
    ContextMessageRecord,
    MessageEntry,
    MessageListInput,
} from "@portable-devshell/shared";

import {
    applyDeliveredControls,
    applyQueuedControl,
    clearMessageControlStates,
    type MessageControlState,
    readMessageControlCommentIds,
    readMessageControlState,
    writeMessageControlState,
} from "../MessageControl.js";
import {
    applyByteBudget,
    messagePayloadBytesSql,
    listMessageRows,
    pendingCommentRecords,
    readMessageEntryPayloadBytes,
    readMessagePayloadBytes,
    toCommentRecord,
    toMessageEntry,
} from "./Query.js";
import { defaultMessageStorageLimits, openMessageDatabase } from "./Schema.js";
import type { MailingNotificationIdentity } from "../../mailing/Service.js";

export { defaultMessageStorageLimits } from "./Schema.js";
export type { MessageControlState } from "../MessageControl.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface MessageStoreStats {
    comments: number;
    entries: number;
    fileBytes: number;
    maxBytes: number;
    payloadBytes: number;
    protectedComments: number;
    reports: number;
    retentionDays: number;
}

export class MessageStore {
    readonly #filePath: string;
    readonly #openDatabase: () => Promise<ExtensionDatabaseConnection>;
    #operation = Promise.resolve();
    readonly #instanceName: string;
    readonly #maxBytes: number;
    readonly #now: () => number;
    readonly #retentionDays: number;
    readonly #retentionMs: number;
    #database?: ExtensionDatabaseConnection;
    #lastRetentionCleanupAt = Number.NEGATIVE_INFINITY;
    #payloadBytes?: number;

    constructor(options: {
        filePath: string;
        openDatabase: () => Promise<ExtensionDatabaseConnection>;
        instanceName: string;
        maxBytes?: number;
        now?: () => number;
        retentionDays?: number;
    }) {
        const maxBytes =
            options.maxBytes ?? defaultMessageStorageLimits.maxBytes;
        const retentionDays =
            options.retentionDays ?? defaultMessageStorageLimits.retentionDays;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
            throw new TypeError(
                "Message maxBytes must be a positive safe integer.",
            );
        }
        if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
            throw new TypeError(
                "Message retentionDays must be a positive safe integer.",
            );
        }
        this.#filePath = options.filePath;
        this.#openDatabase = options.openDatabase;
        this.#instanceName = options.instanceName;
        this.#maxBytes = maxBytes;
        this.#now = options.now ?? Date.now;
        this.#retentionDays = retentionDays;
        this.#retentionMs = retentionDays * DAY_MS;
    }

    async close(): Promise<void> {
        return await this.#exclusive(async () => {
            await this.#database?.close();
            this.#database = undefined;
            this.#lastRetentionCleanupAt = Number.NEGATIVE_INFINITY;
            this.#payloadBytes = undefined;
        });
    }

    async list(input: MessageListInput = {}): Promise<MessageEntry[]> {
        return await this.#exclusive(async () => {
            const database = await this.#open();
            await this.#cleanup(database);
            return applyByteBudget(
                (await listMessageRows(database, input, undefined)).map(
                    toMessageEntry,
                ),
                input.maxBytes,
            );
        });
    }

    async listComments(
        input: ContextMessageListInput = {},
    ): Promise<ContextMessageRecord[]> {
        return await this.#exclusive(async () => {
            const database = await this.#open();
            await this.#cleanup(database);
            return applyByteBudget(
                (await listMessageRows(database, input, "comment")).map((row) =>
                    toCommentRecord(row, this.#instanceName),
                ),
                input.maxBytes,
            );
        });
    }

    async pendingComments(ctxId?: string): Promise<ContextMessageRecord[]> {
        return await this.#exclusive(async () => {
            return await pendingCommentRecords(
                await this.#open(),
                this.#instanceName,
                ctxId,
            );
        });
    }

    async insertComment(record: ContextMessageRecord, identity?: MailingNotificationIdentity): Promise<{
        record: ContextMessageRecord;
        queuedEventPending: boolean;
    }> {
        return await this.#exclusive(async () => {
            if (identity !== undefined && (identity.instance !== this.#instanceName ||
                identity.ctxId !== record.ctxId || record.instance !== this.#instanceName || record.status !== "sent" ||
                notificationParameters(identity).some((value) => typeof value !== "string" || value.length === 0)))
                throw new Error("Mailing notification identity does not match its Comment scope");
            const database = await this.#open();
            let admission = { record, queuedEventPending: true };
            let inserted = false;
            await database.transaction(async (database) => {
                if (identity !== undefined) {
                    const receipt = await database.get<{
                        comment_id: string; created_at: string; text: string; queued_event_recorded: number;
                    }>(`SELECT comment_id, created_at, text, queued_event_recorded FROM mailing_notifications
                        WHERE instance = ? AND workspace = ? AND ctx_id = ? AND mail_id = ? AND notification_kind = ?`,
                        notificationParameters(identity));
                    if (receipt !== undefined) {
                        if (receipt.text !== record.text)
                            throw new Error("Mailing notification payload changed for an existing identity");
                        // This receipt survives history retention. Replays return
                        // the original admission without resurrecting a Comment.
                        admission = { record: { ...record, id: receipt.comment_id, createdAt: receipt.created_at },
                            queuedEventPending: receipt.queued_event_recorded === 0 };
                        return;
                    }
                }
                await database.run(
                    `
                INSERT INTO message_entries(
                    kind, id, ctx_id, created_at, text, status, call_id, delivered_at, failed_at, error
                ) VALUES ('comment', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
                    [
                        record.id,
                        record.ctxId,
                        record.createdAt,
                        record.text,
                        record.status,
                        record.callId ?? null,
                        record.deliveredAt ?? null,
                        record.failedAt ?? null,
                        record.error ?? null,
                    ],
                );
                const state = await readMessageControlState(
                    database,
                    record.ctxId,
                );
                if (record.status === "delivered") {
                    applyQueuedControl(state, record);
                    applyDeliveredControls(state, [record]);
                } else if (
                    record.status === "pending" ||
                    record.status === "sent"
                ) {
                    applyQueuedControl(state, record);
                }
                await writeMessageControlState(database, record.ctxId, state);
                if (identity !== undefined)
                    await database.run(`INSERT INTO mailing_notifications
                        (instance, workspace, ctx_id, mail_id, notification_kind, comment_id, created_at, text)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [...notificationParameters(identity), record.id, record.createdAt, record.text]);
                inserted = true;
            });
            if (identity !== undefined) this.#payloadBytes = await readMessagePayloadBytes(database);
            else if (inserted) this.#payloadBytes =
                this.#trackedPayloadBytes() +
                (await readMessageEntryPayloadBytes(
                    database,
                    "comment",
                    record.id,
                ));
            await this.#cleanup(
                database,
                record.status === "delivered" || record.status === "failed",
            );
            return admission;
        });
    }

    async acknowledgeQueuedEvent(identity: MailingNotificationIdentity): Promise<void> {
        await this.#exclusive(async () => {
            const database = await this.#open();
            const changed = await database.run(`UPDATE mailing_notifications SET queued_event_recorded = 1
                WHERE instance = ? AND workspace = ? AND ctx_id = ? AND mail_id = ? AND notification_kind = ?`,
                notificationParameters(identity));
            if (changed !== 1) throw new Error("Mailing notification receipt is missing during event acknowledgement");
        });
    }

    async readControlState(ctxId: string): Promise<MessageControlState> {
        return await this.#exclusive(async () => {
            return await readMessageControlState(await this.#open(), ctxId);
        });
    }

    async writeControlState(
        ctxId: string,
        state: MessageControlState,
    ): Promise<void> {
        return await this.#exclusive(async () => {
            const database = await this.#open();
            await database.transaction(async (database) => {
                await writeMessageControlState(database, ctxId, state);
            });
        });
    }

    async clearAllControlStates(): Promise<void> {
        return await this.#exclusive(async () => {
            await clearMessageControlStates(await this.#open());
        });
    }

    async deliverComments(
        ctxId: string,
        callId: string,
        deliveredAt: string,
    ): Promise<ContextMessageRecord[]> {
        return await this.#exclusive(async () => {
            const database = await this.#open();
            let pending: ContextMessageRecord[] = [];
            await database.transaction(async (database) => {
                pending = await pendingCommentRecords(
                    database,
                    this.#instanceName,
                    ctxId,
                );
                if (pending.length === 0) {
                    return;
                }
                const update = `
                UPDATE message_entries
                SET status = 'delivered', call_id = ?, delivered_at = ?, failed_at = NULL, error = NULL
                WHERE kind = 'comment' AND id = ?
            `;
                for (const record of pending)
                    await database.run(update, [
                        callId,
                        deliveredAt,
                        record.id,
                    ]);
                const state = await readMessageControlState(database, ctxId);
                applyDeliveredControls(state, pending);
                await writeMessageControlState(database, ctxId, state);
            });
            this.#payloadBytes = await readMessagePayloadBytes(database);
            await this.#cleanup(database, true);
            return pending.map((record) => ({
                ...record,
                callId,
                deliveredAt,
                error: undefined,
                failedAt: undefined,
                status: "delivered" as const,
            }));
        });
    }

    async failComments(
        ids: ReadonlySet<string>,
        error: string,
        failedAt: string,
    ): Promise<void> {
        return await this.#exclusive(async () => {
            if (ids.size === 0) return;
            const database = await this.#open();
            const failedRecords = (
                await listMessageRows(database, {}, "comment")
            )
                .map((row) => toCommentRecord(row, this.#instanceName))
                .filter((record) => ids.has(record.id));
            await database.transaction(async (database) => {
                const update = `
                UPDATE message_entries
                SET status = 'failed', delivered_at = NULL, failed_at = ?, error = ?
                WHERE kind = 'comment' AND id = ?
            `;
                for (const id of ids)
                    await database.run(update, [failedAt, error, id]);
                for (const ctxId of new Set(
                    failedRecords.map((record) => record.ctxId),
                )) {
                    const state = await readMessageControlState(
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
                    await writeMessageControlState(database, ctxId, state);
                }
            });
            this.#payloadBytes = await readMessagePayloadBytes(database);
            await this.#cleanup(database, true);
        });
    }

    async appendReport(input: {
        callId: string;
        createdAt: string;
        ctxId: string;
        push?: { commentId: string; message: string };
        replyCommentId?: string;
        text: string;
    }): Promise<void> {
        return await this.#exclusive(async () => {
            const database = await this.#open();
            let changes = 0;
            await database.transaction(async (database) => {
                const result = await database.run(
                    `
                INSERT INTO message_entries(kind, id, ctx_id, created_at, text, call_id)
                VALUES ('report', ?, ?, ?, ?, ?)
                ON CONFLICT(kind, id) DO NOTHING
            `,
                    [
                        input.callId,
                        input.ctxId,
                        input.createdAt,
                        input.text,
                        input.callId,
                    ],
                );
                changes = result;
                if (changes > 0) {
                    const state = await readMessageControlState(
                        database,
                        input.ctxId,
                    );
                    if (
                        input.replyCommentId !== undefined &&
                        state.pendingReplyCommentId === input.replyCommentId
                    ) {
                        state.pendingReplyCommentId = undefined;
                    }
                    if (
                        input.push !== undefined &&
                        state.pendingPushCommentId === input.push.commentId &&
                        state.pushMessage === input.push.message
                    ) {
                        state.pendingPushCommentId = undefined;
                        state.pushMessage = undefined;
                        state.pushToolCallsRemaining = undefined;
                    }
                    await writeMessageControlState(
                        database,
                        input.ctxId,
                        state,
                    );
                }
            });
            if (changes > 0) {
                this.#payloadBytes =
                    this.#trackedPayloadBytes() +
                    (await readMessageEntryPayloadBytes(
                        database,
                        "report",
                        input.callId,
                    ));
            }
            await this.#cleanup(database, true);
        });
    }

    async stats(): Promise<MessageStoreStats> {
        return await this.#exclusive(async () => {
            const database = await this.#open();
            await this.#cleanup(database);
            const row = (await database.get(
                `
            SELECT
                COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN kind = 'comment' THEN 1 ELSE 0 END), 0) AS comments,
                COALESCE(SUM(CASE WHEN kind = 'report' THEN 1 ELSE 0 END), 0) AS reports,
                COALESCE(SUM(CASE WHEN kind = 'comment' AND status IN ('pending', 'sent') THEN 1 ELSE 0 END), 0) AS protectedComments
            FROM message_entries
        `,
                [],
            )) as {
                comments: number;
                entries: number;
                protectedComments: number;
                reports: number;
            };
            return {
                comments: row.comments,
                entries: row.entries,
                fileBytes:
                    fileSize(this.#filePath) +
                    fileSize(`${this.#filePath}-wal`),
                maxBytes: this.#maxBytes,
                payloadBytes: this.#trackedPayloadBytes(),
                protectedComments: row.protectedComments,
                reports: row.reports,
                retentionDays: this.#retentionDays,
            };
        });
    }

    async #open(): Promise<ExtensionDatabaseConnection> {
        if (this.#database !== undefined) return this.#database;
        const database = await openMessageDatabase(
            this.#openDatabase,
            this.#filePath,
        );
        try {
            this.#database = database;
            this.#payloadBytes = await readMessagePayloadBytes(database);
            await this.#cleanup(database, true);
            return database;
        } catch (error) {
            this.#database = undefined;
            await database.close();
            throw error;
        }
    }

    async #cleanup(
        database: ExtensionDatabaseConnection,
        forceRetention = false,
    ): Promise<void> {
        const now = this.#now();
        let removed = false;
        const protectedCommentIds = [
            ...(await readMessageControlCommentIds(database)),
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
            const expired = (await database.get(
                `
                SELECT COUNT(*) AS entries, COALESCE(SUM(${messagePayloadBytesSql()}), 0) AS payloadBytes
                FROM message_entries
                WHERE
                    (kind = 'report' AND created_at < ?)
                    OR (
                        kind = 'comment'
                        AND status IN ('delivered', 'failed')
                        AND COALESCE(delivered_at, failed_at, created_at) < ?
                        ${protectedCommentClause}
                    )
            `,
                [cutoff, cutoff, ...protectedCommentIds],
            )) as {
                entries: number;
                payloadBytes: number;
            };
            if (expired.entries > 0) {
                await database.run(
                    `
                    DELETE FROM message_entries
                    WHERE
                        (kind = 'report' AND created_at < ?)
                        OR (
                            kind = 'comment'
                            AND status IN ('delivered', 'failed')
                            AND COALESCE(delivered_at, failed_at, created_at) < ?
                            ${protectedCommentClause}
                        )
                `,
                    [cutoff, cutoff, ...protectedCommentIds],
                );
                this.#payloadBytes = Math.max(
                    0,
                    this.#trackedPayloadBytes() - expired.payloadBytes,
                );
                removed = true;
            }
            this.#lastRetentionCleanupAt = now;
        }

        while (this.#trackedPayloadBytes() > this.#maxBytes) {
            const candidates = (await database.all(
                `
                SELECT seq, ${messagePayloadBytesSql()} AS payloadBytes
                FROM message_entries
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
                [...protectedCommentIds],
            )) as Array<{
                payloadBytes: number;
                seq: number;
            }>;
            if (candidates.length === 0) break;
            const remove = "DELETE FROM message_entries WHERE seq = ?";
            let payloadBytes = this.#trackedPayloadBytes();
            await database.transaction(async (database) => {
                for (const candidate of candidates) {
                    if (payloadBytes <= this.#maxBytes) break;
                    await database.run(remove, [candidate.seq]);
                    payloadBytes -= candidate.payloadBytes;
                    removed = true;
                }
            });
            this.#payloadBytes = Math.max(0, payloadBytes);
        }

        if (removed && this.#trackedPayloadBytes() <= this.#maxBytes) {
            const fileBytes =
                fileSize(this.#filePath) + fileSize(`${this.#filePath}-wal`);
            if (fileBytes > this.#maxBytes) {
                await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
                if (fileSize(this.#filePath) > this.#maxBytes)
                    await database.exec("VACUUM");
            }
        }
    }

    async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.#operation.then(operation);
        this.#operation = next.then(
            () => undefined,
            () => undefined,
        );
        return await next;
    }

    #trackedPayloadBytes(): number {
        if (this.#payloadBytes === undefined) {
            throw new Error("Message payload accounting is not initialized.");
        }
        return this.#payloadBytes;
    }
}

function notificationParameters(identity: MailingNotificationIdentity): string[] {
    return [identity.instance, identity.workspace, identity.ctxId, identity.mailId, identity.kind];
}

function fileSize(path: string): number {
    try {
        return statSync(path).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
    }
}
