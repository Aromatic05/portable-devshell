import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface GoalActivityRecord {
    lastAgentActivityAt: string;
    lastExecutionAt?: string;
    noActionStreak: number;
}

export class GoalActivityStore {
    readonly #filePath: string;
    #initialized = false;

    constructor(filePath: string) {
        this.#filePath = filePath;
    }

    read(goalId: string): GoalActivityRecord | undefined {
        const database = this.#open();
        try {
            const row = database.prepare(`
                SELECT last_agent_activity_at AS lastAgentActivityAt,
                       last_execution_at AS lastExecutionAt,
                       no_action_streak AS noActionStreak
                FROM goal_activity
                WHERE goal_id = ?
            `).get(goalId) as {
                lastAgentActivityAt: string;
                lastExecutionAt: string | null;
                noActionStreak: number;
            } | undefined;
            if (row === undefined) return undefined;
            return {
                lastAgentActivityAt: row.lastAgentActivityAt,
                ...(row.lastExecutionAt === null ? {} : { lastExecutionAt: row.lastExecutionAt }),
                noActionStreak: Number(row.noActionStreak),
            };
        } finally {
            database.close();
        }
    }

    readAll(): Map<string, GoalActivityRecord> {
        const database = this.#open();
        try {
            const rows = database.prepare(`
                SELECT goal_id AS goalId,
                       last_agent_activity_at AS lastAgentActivityAt,
                       last_execution_at AS lastExecutionAt,
                       no_action_streak AS noActionStreak
                FROM goal_activity
            `).all() as Array<{
                goalId: string;
                lastAgentActivityAt: string;
                lastExecutionAt: string | null;
                noActionStreak: number;
            }>;
            return new Map(rows.map((row) => [row.goalId, {
                lastAgentActivityAt: row.lastAgentActivityAt,
                ...(row.lastExecutionAt === null ? {} : { lastExecutionAt: row.lastExecutionAt }),
                noActionStreak: Number(row.noActionStreak),
            }]));
        } finally {
            database.close();
        }
    }

    write(goalId: string, activity: GoalActivityRecord): void {
        const database = this.#open();
        try {
            database.prepare(`
                INSERT INTO goal_activity(goal_id, last_agent_activity_at, last_execution_at, no_action_streak)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(goal_id) DO UPDATE SET
                    last_agent_activity_at = excluded.last_agent_activity_at,
                    last_execution_at = excluded.last_execution_at,
                    no_action_streak = excluded.no_action_streak
            `).run(
                goalId,
                activity.lastAgentActivityAt,
                activity.lastExecutionAt ?? null,
                activity.noActionStreak,
            );
        } finally {
            database.close();
        }
    }

    delete(goalId: string): void {
        const database = this.#open();
        try {
            database.prepare("DELETE FROM goal_activity WHERE goal_id = ?").run(goalId);
        } finally {
            database.close();
        }
    }

    #open(): DatabaseSync {
        if (!this.#initialized) {
            mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
            const database = new DatabaseSync(this.#filePath, { timeout: 5_000 });
            try {
                database.exec(`
                    PRAGMA journal_mode = DELETE;
                    PRAGMA synchronous = FULL;
                    CREATE TABLE IF NOT EXISTS goal_activity (
                        goal_id TEXT PRIMARY KEY,
                        last_agent_activity_at TEXT NOT NULL,
                        last_execution_at TEXT,
                        no_action_streak INTEGER NOT NULL CHECK(no_action_streak >= 0)
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
