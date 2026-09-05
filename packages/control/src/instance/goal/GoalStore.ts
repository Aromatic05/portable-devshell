import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { createError, errorCodes, type GoalRecord } from "@portable-devshell/shared";

import { cleanupStaleAtomicStateTemps } from "../AtomicStateFile.js";
import { GoalActivityStore, type GoalActivityRecord } from "./GoalActivityStore.js";
import { GoalState, type GoalDocument } from "./GoalState.js";

export class GoalStore {
    readonly #activityHydrated = new Set<string>();
    readonly #activityStore: GoalActivityStore;
    #activityAvailable = true;
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #state: GoalState;
    #document?: GoalDocument;

    constructor(options: { filePath: string; instanceName: string; state: GoalState }) {
        this.#activityStore = new GoalActivityStore(goalActivityFilePath(options.filePath));
        this.#filePath = options.filePath;
        this.#instanceName = options.instanceName;
        this.#state = options.state;
    }

    read(ctxId?: string): GoalDocument {
        if (ctxId === undefined) this.#hydrateAllActivity();
        else this.#hydrateContextActivity(ctxId);
        return structuredClone(this.#current());
    }

    readStructural(): GoalDocument {
        return structuredClone(this.#current());
    }

    readRecord(ctxId: string): GoalRecord | undefined {
        this.#hydrateContextActivity(ctxId);
        const record = this.#current().goals.find((goal) => goal.createdByCtxId === ctxId);
        return record === undefined ? undefined : structuredClone(record);
    }

    writeActivity(record: GoalRecord): void {
        if (!this.#activityAvailable) throw new Error("Goal activity sidecar is unavailable.");
        const current = this.#current();
        const index = current.goals.findIndex((goal) => goal.goalId === record.goalId);
        if (index === -1) throw new Error(`Workspace Goal ${record.goalId} is no longer stored.`);
        try {
            this.#activityStore.write(record.goalId, goalActivity(record));
        } catch (error) {
            this.#activityAvailable = false;
            throw error;
        }
        current.goals[index] = structuredClone(record);
        this.#activityHydrated.add(record.goalId);
    }

    async write(document: GoalDocument): Promise<GoalDocument> {
        const normalized = this.#state.normalizeDocument(document);
        await this.#writeAtomic(normalized);
        this.#pruneActivity(normalized);
        this.#document = normalized;
        return structuredClone(normalized);
    }

    #hydrateAllActivity(): void {
        const document = this.#current();
        const pending = document.goals.filter((goal) => !this.#activityHydrated.has(goal.goalId));
        if (pending.length === 0 || !this.#activityAvailable) return;
        let activities: Map<string, GoalActivityRecord>;
        try {
            activities = this.#activityStore.readAll();
        } catch {
            this.#activityAvailable = false;
            return;
        }
        for (const goal of pending) {
            const activity = activities.get(goal.goalId);
            if (activity !== undefined) applyGoalActivity(goal, activity);
            this.#activityHydrated.add(goal.goalId);
        }
    }

    #hydrateContextActivity(ctxId: string): void {
        const goal = this.#current().goals.find((entry) => entry.createdByCtxId === ctxId);
        if (goal === undefined || this.#activityHydrated.has(goal.goalId) || !this.#activityAvailable) return;
        let activity: GoalActivityRecord | undefined;
        try {
            activity = this.#activityStore.read(goal.goalId);
        } catch {
            this.#activityAvailable = false;
            return;
        }
        if (activity !== undefined && activity.lastAgentActivityAt > goal.lastAgentActivityAt) {
            applyGoalActivity(goal, activity);
        }
        this.#activityHydrated.add(goal.goalId);
    }

    #pruneActivity(document: GoalDocument): void {
        const retained = new Set(document.goals.map((goal) => goal.goalId));
        const previous = this.#document?.goals ?? [];
        for (const goal of previous) {
            if (!retained.has(goal.goalId)) {
                this.#activityHydrated.delete(goal.goalId);
                try { this.#activityStore.delete(goal.goalId); } catch {
                    // Structural Goal state is already durable; stale activity is safe to ignore.
                }
            }
        }
        for (const goal of document.goals) {
            if (goal.status === "completed" || goal.status === "stopped") {
                this.#activityHydrated.delete(goal.goalId);
                try { this.#activityStore.delete(goal.goalId); } catch {
                    // Structural Goal state is already durable; stale activity is safe to ignore.
                }
            }
        }
    }

    #current(): GoalDocument {
        if (this.#document === undefined) {
            cleanupStaleAtomicStateTemps(this.#filePath);
            this.#document = this.#load();
        }
        return this.#document;
    }

    #load(): GoalDocument {
        if (!existsSync(this.#filePath)) return this.#state.emptyDocument();
        try {
            return this.#state.normalizeDocument(JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown);
        } catch (error) {
            throw createError({
                cause: error,
                code: errorCodes.targetInvalid,
                details: { filePath: this.#filePath },
                message: `Goal state for ${this.#instanceName} is invalid.`,
                retryable: false,
            });
        }
    }

    async #writeAtomic(document: GoalDocument): Promise<void> {
        const directory = dirname(this.#filePath);
        await mkdir(directory, { mode: 0o700, recursive: true });
        const temporary = `${this.#filePath}.tmp.${process.pid}.${randomUUID()}`;
        try {
            const handle = await open(temporary, "wx", 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await rename(temporary, this.#filePath);
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        if (process.platform !== "win32") {
            const handle = await open(directory, "r");
            try { await handle.sync(); } finally { await handle.close(); }
        }
    }
}

function applyGoalActivity(record: GoalRecord, activity: GoalActivityRecord): void {
    record.lastAgentActivityAt = activity.lastAgentActivityAt;
    if (activity.lastExecutionAt === undefined) delete record.lastExecutionAt;
    else record.lastExecutionAt = activity.lastExecutionAt;
    record.noActionStreak = activity.noActionStreak;
}

function goalActivity(record: GoalRecord): GoalActivityRecord {
    return {
        lastAgentActivityAt: record.lastAgentActivityAt,
        ...(record.lastExecutionAt === undefined ? {} : { lastExecutionAt: record.lastExecutionAt }),
        noActionStreak: record.noActionStreak,
    };
}

function goalActivityFilePath(filePath: string): string {
    return filePath.endsWith(".json")
        ? `${filePath.slice(0, -5)}.activity.sqlite3`
        : `${filePath}.activity.sqlite3`;
}
