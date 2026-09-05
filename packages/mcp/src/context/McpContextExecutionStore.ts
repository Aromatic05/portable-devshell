import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface McpContextExecutionRecord {
    executionEpoch: number;
    executionLastActivityAt?: string;
    executionLeaseUntil?: string;
}

export class McpContextExecutionStore {
    readonly #filePath?: string;
    #initialized = false;

    constructor(filePath?: string) {
        this.#filePath = filePath;
    }

    read(ctxId: string): McpContextExecutionRecord | undefined {
        const database = this.#open();
        if (database === undefined) return undefined;
        try {
            const row = database.prepare(`
                SELECT execution_epoch AS executionEpoch,
                       execution_last_activity_at AS executionLastActivityAt,
                       execution_lease_until AS executionLeaseUntil
                FROM context_execution
                WHERE ctx_id = ?
            `).get(ctxId) as {
                executionEpoch: number;
                executionLastActivityAt: string | null;
                executionLeaseUntil: string | null;
            } | undefined;
            if (row === undefined) return undefined;
            return {
                executionEpoch: Number(row.executionEpoch),
                ...(row.executionLastActivityAt === null ? {} : { executionLastActivityAt: row.executionLastActivityAt }),
                ...(row.executionLeaseUntil === null ? {} : { executionLeaseUntil: row.executionLeaseUntil }),
            };
        } finally {
            database.close();
        }
    }

    write(ctxId: string, record: McpContextExecutionRecord): void {
        const database = this.#open();
        if (database === undefined) return;
        try {
            database.prepare(`
                INSERT INTO context_execution(
                    ctx_id, execution_epoch, execution_last_activity_at, execution_lease_until
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(ctx_id) DO UPDATE SET
                    execution_epoch = excluded.execution_epoch,
                    execution_last_activity_at = excluded.execution_last_activity_at,
                    execution_lease_until = excluded.execution_lease_until
            `).run(
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
            database.prepare("DELETE FROM context_execution WHERE ctx_id = ?").run(ctxId);
        } finally {
            database.close();
        }
    }

    #open(): DatabaseSync | undefined {
        if (this.#filePath === undefined) return undefined;
        if (!this.#initialized) {
            mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
            const database = new DatabaseSync(this.#filePath, { timeout: 5_000 });
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
