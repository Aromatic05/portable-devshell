import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
    createRemoteError,
    controlErrorCodes,
    RemoteError,
    type GoalRecord,
} from "@portable-devshell/shared";

import { cleanupStaleAtomicStateTemps } from "../../AtomicState.js";
import { GoalActivityStore, type GoalActivityRecord } from "./Activity.js";
import { GoalState, type GoalDocument } from "./State.js";

export class GoalCommitError extends RemoteError {
    constructor(
        cause: unknown,
        readonly committed: true | "unknown",
        filePath: string,
        phase: "rename" | "directory-sync",
    ) {
        super({
            cause,
            code: committed === true
                ? "goal.commitDurabilityUnconfirmed"
                : "goal.commitUncertain",
            details: { committed, filePath, phase },
            message: committed === true
                ? "Goal update is committed, but crash durability is unconfirmed; read the Goal before changing it again."
                : "Goal commit outcome is unknown; read the Goal before retrying.",
            retryable: false,
        });
        this.name = "GoalCommitError";
    }
}

export class GoalStore {
    readonly #activityHydrated = new Set<string>();
    readonly #activityStore: GoalActivityStore;
    #activityAvailable = true;
    readonly #filePath: string;
    readonly #instanceName: string;
    readonly #state: GoalState;
    #document?: GoalDocument;
    #pendingCommit?: {
        document: GoalDocument;
        onCommitted?: () => Promise<void>;
    };

    constructor(options: {
        filePath: string;
        instanceName: string;
        state: GoalState;
    }) {
        this.#activityStore = new GoalActivityStore(
            goalActivityFilePath(options.filePath),
        );
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
        const record = this.#current().goals.find(
            (goal) => goal.createdByCtxId === ctxId,
        );
        return record === undefined ? undefined : structuredClone(record);
    }

    writeActivity(record: GoalRecord): void {
        if (!this.#activityAvailable)
            throw new Error("Goal activity sidecar is unavailable.");
        const current = this.#current();
        const index = current.goals.findIndex(
            (goal) => goal.goalId === record.goalId,
        );
        if (index === -1)
            throw new Error(
                `Workspace Goal ${record.goalId} is no longer stored.`,
            );
        try {
            this.#activityStore.write(record.goalId, {
                ...goalActivity(record),
                structureHash: goalStructureHash(current.goals[index]!),
            });
        } catch (error) {
            this.#activityAvailable = false;
            throw error;
        }
        current.goals[index] = structuredClone(record);
        this.#activityHydrated.add(record.goalId);
    }

    async reconcile(): Promise<void> {
        const pending = this.#pendingCommit;
        if (pending === undefined) return;
        // Never use the old cache when a rename might already be visible.
        // An unreadable file must block all subsequent mutations.
        const stored = this.#load();
        this.#pruneActivity(stored);
        this.#activityHydrated.clear();
        this.#document = stored;
        this.#pendingCommit = undefined;
        if (isDeepStrictEqual(stored, pending.document))
            await pending.onCommitted?.();
    }

    async write(
        document: GoalDocument,
        onCommitted?: () => Promise<void>,
    ): Promise<GoalDocument> {
        await this.reconcile();
        const normalized = this.#state.normalizeDocument(document);
        let failure: GoalCommitError | undefined;
        try {
            await this.#writeAtomic(normalized);
        } catch (error) {
            if (!(error instanceof GoalCommitError)) throw error;
            this.#invalidate();
            if (error.committed === "unknown") {
                this.#pendingCommit = { document: normalized, onCommitted };
                throw error;
            }
            failure = error;
        }
        this.#pruneActivity(normalized);
        this.#activityHydrated.clear();
        this.#document = normalized;
        await onCommitted?.();
        if (failure !== undefined) throw failure;
        return structuredClone(normalized);
    }

    #hydrateAllActivity(): void {
        const document = this.#current();
        const pending = document.goals.filter(
            (goal) => !this.#activityHydrated.has(goal.goalId),
        );
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
            // Structural progress may have committed after the last sidecar
            // heartbeat. Never replace that newer state with a stale row.
            if (activity !== undefined && shouldHydrateActivity(goal, activity))
                applyGoalActivity(goal, activity);
            this.#activityHydrated.add(goal.goalId);
        }
    }

    #hydrateContextActivity(ctxId: string): void {
        const goal = this.#current().goals.find(
            (entry) => entry.createdByCtxId === ctxId,
        );
        if (
            goal === undefined ||
            this.#activityHydrated.has(goal.goalId) ||
            !this.#activityAvailable
        )
            return;
        let activity: GoalActivityRecord | undefined;
        try {
            activity = this.#activityStore.read(goal.goalId);
        } catch {
            this.#activityAvailable = false;
            return;
        }
        if (
            activity !== undefined &&
            shouldHydrateActivity(goal, activity)
        ) {
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
                try {
                    this.#activityStore.delete(goal.goalId);
                } catch {
                    // Structural Goal state is already durable; stale activity is safe to ignore.
                }
            }
        }
        for (const goal of document.goals) {
            if (goal.status === "completed" || goal.status === "stopped") {
                this.#activityHydrated.delete(goal.goalId);
                try {
                    this.#activityStore.delete(goal.goalId);
                } catch {
                    // Structural Goal state is already durable; stale activity is safe to ignore.
                }
            }
        }
    }

    #current(): GoalDocument {
        if (this.#pendingCommit !== undefined) return this.#load();
        if (this.#document === undefined) {
            cleanupStaleAtomicStateTemps(this.#filePath);
            this.#document = this.#load();
        }
        return this.#document;
    }

    #invalidate(): void {
        this.#document = undefined;
        this.#activityHydrated.clear();
    }

    #load(): GoalDocument {
        if (!existsSync(this.#filePath)) return this.#state.emptyDocument();
        try {
            return this.#state.normalizeDocument(
                JSON.parse(readFileSync(this.#filePath, "utf8")) as unknown,
            );
        } catch (error) {
            throw createRemoteError({
                cause: error,
                code: controlErrorCodes.invalidTarget,
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
        } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
        try {
            await rename(temporary, this.#filePath);
        } catch (error) {
            this.#invalidate();
            let stored: GoalDocument;
            try {
                stored = this.#load();
            } catch (probeError) {
                throw new GoalCommitError(
                    new AggregateError([error, probeError], "Goal rename and reconciliation failed."),
                    "unknown", this.#filePath, "rename",
                );
            } finally {
                await unlink(temporary).catch(() => undefined);
            }
            if (isDeepStrictEqual(stored, document))
                throw new GoalCommitError(error, true, this.#filePath, "rename");
            throw error;
        }
        if (process.platform !== "win32") {
            try {
                const handle = await open(directory, "r");
                try {
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            } catch (error) {
                throw new GoalCommitError(error, true, this.#filePath, "directory-sync");
            }
        }
    }
}

function applyGoalActivity(
    record: GoalRecord,
    activity: GoalActivityRecord,
): void {
    record.lastAgentActivityAt = activity.lastAgentActivityAt;
    if (activity.lastExecutionAt === undefined) delete record.lastExecutionAt;
    else record.lastExecutionAt = activity.lastExecutionAt;
    record.noActionStreak = activity.noActionStreak;
}

function shouldHydrateActivity(goal: GoalRecord, activity: GoalActivityRecord): boolean {
    if (goal.status !== "active") return false;
    // A matching structural generation establishes causality even for events
    // in the same millisecond or after a wall-clock adjustment.
    return activity.structureHash === undefined
        ? activity.lastAgentActivityAt > goal.lastAgentActivityAt
        : activity.structureHash === goalStructureHash(goal);
}

function goalStructureHash(record: GoalRecord): string {
    const { lastAgentActivityAt: _activity, lastExecutionAt: _execution,
        noActionStreak: _streak, ...structure } = record;
    const canonical = Object.entries(structure).sort(([a], [b]) => a.localeCompare(b));
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function goalActivity(record: GoalRecord): GoalActivityRecord {
    return {
        lastAgentActivityAt: record.lastAgentActivityAt,
        ...(record.lastExecutionAt === undefined
            ? {}
            : { lastExecutionAt: record.lastExecutionAt }),
        noActionStreak: record.noActionStreak,
    };
}

function goalActivityFilePath(filePath: string): string {
    return filePath.endsWith(".json")
        ? `${filePath.slice(0, -5)}.activity.sqlite3`
        : `${filePath}.activity.sqlite3`;
}
