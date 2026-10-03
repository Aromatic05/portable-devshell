import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContextReentryPort, GoalActivityKind } from "@portable-devshell/shared";
import { MCP_CONTEXT_EXECUTION_LEASE_MS, type McpContextAutomaticReentryMode, type McpContextAutomaticReentryState, type McpContextStoredRecord } from "../Model.js";
import type { ContextStatePort } from "./Record.js";
import {
    invalidContext,
    cloneStoredRecord,
    automaticReentryState,
    clearAutomaticReentryClaim,
    applyExecutionRecord,
    executionRecord,
    contextExecutionActive,
    automaticReentryClaimFresh,
} from "./Record.js";

export interface ContextReentryStorePort extends ContextStatePort {
    now(): number;
    persist(): Promise<void>;
    validateForInstance(ctxId: string, instance: string, options: { execution: boolean }): Promise<unknown>;
}

export class ContextReentry implements ContextReentryPort {
    readonly #executionHydrated = new Set<string>();
    readonly #executionStore: ContextExecutionStore;
    readonly #host: ContextReentryStorePort;

    constructor(host: ContextReentryStorePort, executionFilePath?: string) {
        this.#host = host;
        this.#executionStore = new ContextExecutionStore(executionFilePath);
    }

    forget(ctxId: string): void {
        this.#executionHydrated.delete(ctxId);
        this.#executionStore.delete(ctxId);
    }

    async readAutomaticReentry(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            return automaticReentryState(record, this.#host.now());
        });
    }

    async suppressAutomaticReentry(
        ctxId: string,
        instance: string,
        reason: string,
        mode: Exclude<
            McpContextAutomaticReentryMode,
            "automatic"
        > = "user_owned",
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const at = new Date(this.#host.now()).toISOString();
            await this.#host.mutate(() => {
                record.automaticReentryEpoch =
                    (record.automaticReentryEpoch ?? 0) + 1;
                record.automaticReentryMode = mode;
                record.automaticReentrySuppressedAt = at;
                record.automaticReentrySuppressionReason = reason;
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
                delete record.automaticReentryInstance;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
            });
            return automaticReentryState(record, this.#host.now());
        });
    }

    async resumeAutomaticReentry(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            await this.#host.mutate(() => {
                record.automaticReentryEpoch =
                    (record.automaticReentryEpoch ?? 0) + 1;
                delete record.automaticReentryMode;
                delete record.automaticReentrySuppressedAt;
                delete record.automaticReentrySuppressionReason;
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
                delete record.automaticReentryInstance;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
            });
            return automaticReentryState(record, this.#host.now());
        });
    }

    async observeAutomaticReentryActivity(
        ctxId: string,
        instance: string,
        kind: GoalActivityKind,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (
                kind === "observation" ||
                record.automaticReentryMode !== "user_owned"
            ) {
                return automaticReentryState(record, this.#host.now());
            }
            await this.#host.mutate(() => {
                record.automaticReentryEpoch =
                    (record.automaticReentryEpoch ?? 0) + 1;
                delete record.automaticReentryMode;
                delete record.automaticReentrySuppressedAt;
                delete record.automaticReentrySuppressionReason;
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
                delete record.automaticReentryInstance;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
            });
            return automaticReentryState(record, this.#host.now());
        });
    }

    async observeExecutionActivity(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#host.now();
            const previous = cloneStoredRecord(record);
            const clearsClaim =
                record.automaticReentryAttemptedAt === undefined &&
                (record.automaticReentryClaimedAt !== undefined ||
                    record.automaticReentryClaimId !== undefined ||
                    record.automaticReentryInstance !== undefined ||
                    record.automaticReentrySourceId !== undefined ||
                    record.automaticReentrySourceKind !== undefined);
            try {
                record.executionEpoch = (record.executionEpoch ?? 0) + 1;
                record.executionLastActivityAt = new Date(now).toISOString();
                record.executionLeaseUntil = new Date(
                    now + MCP_CONTEXT_EXECUTION_LEASE_MS,
                ).toISOString();
                if (record.automaticReentryAttemptedAt === undefined) {
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                    delete record.automaticReentryInstance;
                    delete record.automaticReentrySourceId;
                    delete record.automaticReentrySourceKind;
                }
                await this.#persistExecution(record, clearsClaim);
            } catch (error) {
                this.#host.records.set(previous.ctxId, previous);
                this.#executionHydrated.delete(previous.ctxId);
                throw error;
            }
            return automaticReentryState(record, now);
        });
    }

    async releaseExecutionActivity(
        ctxId: string,
        instance: string,
        expectedEpoch: number,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#host.now();
            if ((record.executionEpoch ?? 0) !== expectedEpoch) {
                return automaticReentryState(record, now);
            }
            const previous = cloneStoredRecord(record);
            try {
                record.executionEpoch = expectedEpoch + 1;
                delete record.executionLeaseUntil;
                await this.#persistExecution(record, false);
            } catch (error) {
                this.#host.records.set(previous.ctxId, previous);
                this.#executionHydrated.delete(previous.ctxId);
                throw error;
            }
            return automaticReentryState(record, now);
        });
    }

    async markAutomaticReentryAttempted(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#host.now();
            if (
                record.automaticReentrySuppressedAt !== undefined ||
                contextExecutionActive(record, now) ||
                !automaticReentryClaimFresh(record, now) ||
                record.automaticReentryClaimId !== claimId ||
                record.automaticReentryInstance !== instance
            ) {
                throw new Error(
                    `Automatic re-entry claim ${claimId} is no longer active.`,
                );
            }
            if (record.automaticReentryAttemptedAt === undefined) {
                await this.#host.mutate(() => {
                    record.automaticReentryAttemptedAt = new Date(
                        now,
                    ).toISOString();
                });
            }
            return automaticReentryState(record, now);
        });
    }

    async markAutomaticReentryAccepted(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#host.now();
            if (
                record.automaticReentrySuppressedAt !== undefined ||
                !automaticReentryClaimFresh(record, now) ||
                record.automaticReentryClaimId !== claimId ||
                record.automaticReentryInstance !== instance
            ) {
                throw new Error(
                    `Automatic re-entry claim ${claimId} is no longer active.`,
                );
            }
            await this.#host.mutate(() => {
                record.executionEpoch = (record.executionEpoch ?? 0) + 1;
                record.executionLastActivityAt = new Date(now).toISOString();
                record.executionLeaseUntil = new Date(
                    now + MCP_CONTEXT_EXECUTION_LEASE_MS,
                ).toISOString();
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentryClaimedAt;
                delete record.automaticReentryClaimId;
                delete record.automaticReentryInstance;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
            });
            this.#persistExecutionBestEffort(record);
            return automaticReentryState(record, now);
        });
    }

    async markAutomaticReentryRejected(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (
                record.automaticReentryClaimId === claimId &&
                record.automaticReentryInstance === instance
            ) {
                await this.#host.mutate(() => {
                    delete record.automaticReentryAttemptedAt;
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                    delete record.automaticReentryInstance;
                    delete record.automaticReentrySourceId;
                    delete record.automaticReentrySourceKind;
                });
            }
            return automaticReentryState(record, this.#host.now());
        });
    }

    async claimAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<{ claimed: boolean; state: McpContextAutomaticReentryState }> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#host.now();
            const freshClaim = automaticReentryClaimFresh(record, now);
            if (
                record.automaticReentrySuppressedAt !== undefined ||
                contextExecutionActive(record, now) ||
                (freshClaim &&
                    (record.automaticReentryClaimId !== claimId ||
                        record.automaticReentryInstance !== instance))
            ) {
                return {
                    claimed: false,
                    state: automaticReentryState(record, now),
                };
            }
            await this.#host.mutate(() => {
                delete record.automaticReentryAttemptedAt;
                delete record.automaticReentrySourceId;
                delete record.automaticReentrySourceKind;
                record.automaticReentryClaimId = claimId;
                record.automaticReentryClaimedAt = new Date(now).toISOString();
                record.automaticReentryInstance = instance;
            });
            return { claimed: true, state: automaticReentryState(record, now) };
        });
    }

    async bindAutomaticReentrySource(
        ctxId: string,
        instance: string,
        claimId: string,
        sourceKind:
            "goal" | "goal-resume" | "goal-retry" | "task-resume" | "wait",
        sourceId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#host.now();
            if (
                !automaticReentryClaimFresh(record, now) ||
                record.automaticReentryClaimId !== claimId ||
                record.automaticReentryInstance !== instance
            ) {
                throw new Error(
                    `Automatic re-entry claim ${claimId} is no longer active.`,
                );
            }
            if (
                record.automaticReentrySourceKind !== undefined &&
                (record.automaticReentrySourceKind !== sourceKind ||
                    record.automaticReentrySourceId !== sourceId)
            ) {
                throw new Error(
                    `Automatic re-entry claim ${claimId} is already bound to another source.`,
                );
            }
            if (record.automaticReentrySourceKind === undefined) {
                await this.#host.mutate(() => {
                    record.automaticReentrySourceKind = sourceKind;
                    record.automaticReentrySourceId = sourceId;
                });
            }
            return automaticReentryState(record, now);
        });
    }

    async validateAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<{ state: McpContextAutomaticReentryState; valid: boolean }> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            const now = this.#host.now();
            const valid =
                record.automaticReentrySuppressedAt === undefined &&
                !contextExecutionActive(record, now) &&
                automaticReentryClaimFresh(record, now) &&
                record.automaticReentryClaimId === claimId &&
                record.automaticReentryInstance === instance;
            return { state: automaticReentryState(record, now), valid };
        });
    }

    async releaseAutomaticReentry(
        ctxId: string,
        instance: string,
        claimId: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (
                record.automaticReentryClaimId === claimId &&
                record.automaticReentryInstance === instance
            ) {
                if (record.automaticReentryAttemptedAt !== undefined) {
                    throw new Error(
                        `Automatic re-entry claim ${claimId} was already attempted.`,
                    );
                }
                await this.#host.mutate(() => {
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                    delete record.automaticReentryInstance;
                    delete record.automaticReentrySourceId;
                    delete record.automaticReentrySourceKind;
                });
            }
            return automaticReentryState(record, this.#host.now());
        });
    }

    async clearAutomaticReentryClaim(
        ctxId: string,
        instance: string,
    ): Promise<McpContextAutomaticReentryState> {
        await this.#host.validateForInstance(ctxId, instance, { execution: true });
        return await this.#host.run(async () => {
            const record = this.#host.records.get(ctxId);
            if (record === undefined) throw invalidContext(ctxId);
            if (
                record.automaticReentryInstance === instance &&
                (record.automaticReentryClaimId !== undefined ||
                    record.automaticReentryClaimedAt !== undefined)
            ) {
                await this.#host.mutate(() => {
                    delete record.automaticReentryAttemptedAt;
                    delete record.automaticReentryClaimedAt;
                    delete record.automaticReentryClaimId;
                    delete record.automaticReentryInstance;
                    delete record.automaticReentrySourceId;
                    delete record.automaticReentrySourceKind;
                });
            }
            return automaticReentryState(record, this.#host.now());
        });
    }

    async listAutomaticReentryClaimsForInstance(instance: string): Promise<
        Array<{
            attempted: boolean;
            claimId: string;
            ctxId: string;
            sourceId?: string;
            sourceKind?:
                "goal" | "goal-resume" | "goal-retry" | "task-resume" | "wait";
        }>
    > {
        return await this.#host.run(async () => {
            return [...this.#host.records.values()]
                .filter(
                    (record) =>
                        record.automaticReentryInstance === instance &&
                        record.automaticReentryClaimId !== undefined,
                )
                .map((record) => ({
                    attempted: record.automaticReentryAttemptedAt !== undefined,
                    claimId: record.automaticReentryClaimId!,
                    ctxId: record.ctxId,
                    ...(record.automaticReentrySourceId === undefined
                        ? {}
                        : { sourceId: record.automaticReentrySourceId }),
                    ...(record.automaticReentrySourceKind === undefined
                        ? {}
                        : { sourceKind: record.automaticReentrySourceKind }),
                }));
        });
    }

    hydrate(record: McpContextStoredRecord): void {
        if (this.#executionHydrated.has(record.ctxId)) return;
        const stored = this.#executionStore.read(record.ctxId);
        const currentEpoch = record.executionEpoch ?? 0;
        if (stored !== undefined && stored.executionEpoch > currentEpoch) {
            applyExecutionRecord(record, stored);
        } else if (
            stored === undefined &&
            (record.executionEpoch !== undefined ||
                record.executionLastActivityAt !== undefined ||
                record.executionLeaseUntil !== undefined)
        ) {
            this.#persistExecutionBestEffort(record);
        } else if (
            stored !== undefined &&
            currentEpoch > stored.executionEpoch
        ) {
            this.#persistExecutionBestEffort(record);
        }
        this.#executionHydrated.add(record.ctxId);
    }

    async #persistExecution(
        record: McpContextStoredRecord,
        persistStructural: boolean,
    ): Promise<void> {
        this.#executionStore.write(record.ctxId, executionRecord(record));
        this.#executionHydrated.add(record.ctxId);
        if (persistStructural) await this.#host.persist();
    }

    #persistExecutionBestEffort(record: McpContextStoredRecord): void {
        try {
            this.#executionStore.write(record.ctxId, executionRecord(record));
            this.#executionHydrated.add(record.ctxId);
        } catch {
        }
    }

}

export interface ContextExecutionRecord {
    executionEpoch: number;
    executionLastActivityAt?: string;
    executionLeaseUntil?: string;
}

export class ContextExecutionStore {
    readonly #filePath?: string;
    #initialized = false;

    constructor(filePath?: string) {
        this.#filePath = filePath;
    }

    read(ctxId: string): ContextExecutionRecord | undefined {
        const database = this.#open();
        if (database === undefined) return undefined;
        try {
            const row = database
                .prepare(
                    `
                SELECT execution_epoch AS executionEpoch,
                       execution_last_activity_at AS executionLastActivityAt,
                       execution_lease_until AS executionLeaseUntil
                FROM context_execution
                WHERE ctx_id = ?
            `,
                )
                .get(ctxId) as
                | {
                      executionEpoch: number;
                      executionLastActivityAt: string | null;
                      executionLeaseUntil: string | null;
                  }
                | undefined;
            if (row === undefined) return undefined;
            return {
                executionEpoch: Number(row.executionEpoch),
                ...(row.executionLastActivityAt === null
                    ? {}
                    : { executionLastActivityAt: row.executionLastActivityAt }),
                ...(row.executionLeaseUntil === null
                    ? {}
                    : { executionLeaseUntil: row.executionLeaseUntil }),
            };
        } finally {
            database.close();
        }
    }

    write(ctxId: string, record: ContextExecutionRecord): void {
        const database = this.#open();
        if (database === undefined) return;
        try {
            database
                .prepare(
                    `
                INSERT INTO context_execution(
                    ctx_id, execution_epoch, execution_last_activity_at, execution_lease_until
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(ctx_id) DO UPDATE SET
                    execution_epoch = excluded.execution_epoch,
                    execution_last_activity_at = excluded.execution_last_activity_at,
                    execution_lease_until = excluded.execution_lease_until
            `,
                )
                .run(
                    ctxId,
                    record.executionEpoch,
                    record.executionLastActivityAt ?? null,
                    record.executionLeaseUntil ?? null,
                );
        } finally {
            database.close();
        }
    }

    delete(ctxId: string): void {
        if (this.#filePath === undefined) return;
        const database = this.#open();
        if (database === undefined) return;
        try {
            database
                .prepare("DELETE FROM context_execution WHERE ctx_id = ?")
                .run(ctxId);
        } finally {
            database.close();
        }
    }

    #open(): DatabaseSync | undefined {
        if (this.#filePath === undefined) return undefined;
        if (!this.#initialized) {
            mkdirSync(dirname(this.#filePath), {
                recursive: true,
                mode: 0o700,
            });
            const database = new DatabaseSync(this.#filePath, {
                timeout: 5_000,
            });
            try {
                database.exec(`
                    PRAGMA journal_mode = DELETE;
                    PRAGMA synchronous = FULL;
                    CREATE TABLE IF NOT EXISTS context_execution (
                        ctx_id TEXT PRIMARY KEY,
                        execution_epoch INTEGER NOT NULL CHECK(execution_epoch >= 0),
                        execution_last_activity_at TEXT,
                        execution_lease_until TEXT
                    ) STRICT;
                `);
            } finally {
                database.close();
            }
            this.#initialized = true;
        }
        const database = new DatabaseSync(this.#filePath, { timeout: 5_000 });
        database.exec("PRAGMA synchronous = FULL");
        return database;
    }
}
