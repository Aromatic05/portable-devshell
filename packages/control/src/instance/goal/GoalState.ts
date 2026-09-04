import { randomUUID } from "node:crypto";

import type {
    GoalActivityKind,
    GoalContinuationInput,
    GoalManageInput,
    GoalRecord,
    GoalSnapshot,
    GoalStep,
    GoalStepInput,
    GoalStepStatus,
} from "@portable-devshell/shared";

export const GOAL_EXECUTION_LEASE_MS = 60 * 1_000;
export const GOAL_MAX_CONTINUATIONS = 0;
const GOAL_CONTINUATION_CLAIM_TTL_MS = 5 * 60 * 1_000;
const GOAL_CONTINUATION_RETRY_MS = 5 * 60 * 1_000;
const MAX_TERMINAL_GOALS = 1_000;
const GOAL_MAX_STEPS = 100;
const GOAL_OBJECTIVE_LIMIT = 4_000;
const GOAL_STEP_ID_LIMIT = 128;
const GOAL_STEP_TEXT_LIMIT = 2_000;
const GOAL_NOTE_LIMIT = 2_000;

export interface GoalDocument {
    goals: GoalRecord[];
    version: 1;
}

export interface GoalTransition<T = GoalSnapshot | undefined> {
    document: GoalDocument;
    result: T;
}

export class GoalState {
    readonly #goalId: () => string;
    readonly #now: () => string;

    constructor(options: { goalId?: () => string; now?: () => string } = {}) {
        this.#goalId = options.goalId ?? (() => `goal-${randomUUID()}`);
        this.#now = options.now ?? (() => new Date().toISOString());
    }

    emptyDocument(): GoalDocument {
        return { goals: [], version: 1 };
    }

    normalizeDocument(value: unknown): GoalDocument {
        if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.goals)) {
            throw new Error("goal document must contain version 1 and a goals array");
        }
        const goals = value.goals.map((entry) => normalizeStoredGoal(entry));
        const contexts = new Set(goals.map((goal) => goal.createdByCtxId));
        if (contexts.size !== goals.length) throw new Error("goal contexts must be unique");
        return this.compact({ goals, version: 1 });
    }

    read(document: GoalDocument, ctxId: string): GoalSnapshot | undefined {
        const record = document.goals.find((goal) => goal.createdByCtxId === ctxId);
        return record === undefined ? undefined : snapshot(record, this.#now());
    }

    list(document: GoalDocument): GoalSnapshot[] {
        const now = this.#now();
        return document.goals
            .filter((goal) => goal.status === "active" || goal.status === "blocked" || goal.status === "paused")
            .map((goal) => snapshot(goal, now));
    }

    manage(document: GoalDocument, input: GoalManageInput, ctxId: string): GoalTransition {
        const action = input.action;
        if (action === "get") return { document, result: this.read(document, ctxId) };
        if (action === "start") return this.#start(document, input, ctxId);

        const index = document.goals.findIndex((goal) => goal.createdByCtxId === ctxId);
        if (index === -1) throw new Error("No Workspace Goal is attached to the current Context.");
        const current = document.goals[index]!;
        if (input.expectedGoalId !== undefined && input.expectedGoalId !== current.goalId) {
            throw new Error(`Workspace Goal changed from ${input.expectedGoalId} to ${current.goalId}; refresh before retrying.`);
        }
        if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
            throw new Error(`Workspace Goal ${current.goalId} changed from revision ${input.expectedRevision} to ${current.revision}; refresh before retrying.`);
        }
        if (current.status === "completed" || current.status === "stopped") {
            throw new Error(`Workspace Goal ${current.goalId} is already ${current.status}.`);
        }
        if (input.workspace !== undefined && current.workspace !== undefined && input.workspace !== current.workspace) {
            throw new Error(`Workspace Goal ${current.goalId} belongs to ${current.workspace}, not ${input.workspace}.`);
        }
        if (current.status === "paused" && action !== "resume" && action !== "stop") {
            throw new Error("A paused Workspace Goal can only be resumed or stopped by the user.");
        }

        const now = this.#now();
        let next: GoalRecord;
        switch (action) {
            case "update":
                next = updateGoal(current, input, now);
                break;
            case "block":
                if (current.status !== "active") throw new Error("Only an active Workspace Goal can be blocked.");
                next = {
                    ...clearContinuation(current),
                    continuationCount: 0,
                    continuationRetryAfter: undefined,
                    lastAgentActivityAt: now,
                    lastExecutionAt: now,
                    noActionStreak: 0,
                    note: requiredText(input.note, "note", GOAL_NOTE_LIMIT),
                    revision: current.revision + 1,
                    stagnationStreak: 0,
                    status: "blocked",
                    updatedAt: now,
                };
                break;
            case "pause":
                if (input.userControl !== true) throw new Error("Workspace Goal pause is a user-control action.");
                if (current.status !== "active") throw new Error("Only an active Workspace Goal can be paused.");
                next = {
                    ...clearContinuation(current),
                    continuationCount: 0,
                    continuationRetryAfter: undefined,
                    lastAgentActivityAt: now,
                    lastControlAt: now,
                    noActionStreak: 0,
                    revision: current.revision + 1,
                    stagnationStreak: 0,
                    status: "paused",
                    updatedAt: now,
                };
                break;
            case "resume":
                if (current.status === "paused" && input.userControl !== true) {
                    throw new Error("A paused Workspace Goal requires an explicit user resume.");
                }
                if (current.status !== "blocked" && current.status !== "paused") {
                    throw new Error("Only a blocked or paused Workspace Goal can be resumed.");
                }
                next = {
                    ...clearContinuation(current),
                    continuationCount: 0,
                    continuationRetryAfter: undefined,
                    lastAgentActivityAt: now,
                    ...(input.userControl === true ? { lastControlAt: now } : { lastExecutionAt: now }),
                    noActionStreak: 0,
                    note: undefined,
                    revision: current.revision + 1,
                    stagnationStreak: 0,
                    status: "active",
                    updatedAt: now,
                };
                break;
            case "finish":
                if (current.steps.some((step) => step.status === "pending" || step.status === "active")) {
                    throw new Error("Workspace Goal cannot finish until every step is completed or skipped.");
                }
                next = {
                    ...clearContinuation(current),
                    continuationCount: 0,
                    lastAgentActivityAt: now,
                    lastExecutionAt: now,
                    lastProgressAt: now,
                    noActionStreak: 0,
                    revision: current.revision + 1,
                    stagnationStreak: 0,
                    status: "completed",
                    updatedAt: now,
                };
                break;
            case "stop":
                next = {
                    ...clearContinuation(current),
                    continuationCount: 0,
                    lastAgentActivityAt: now,
                    lastProgressAt: now,
                    noActionStreak: 0,
                    revision: current.revision + 1,
                    stagnationStreak: 0,
                    status: "stopped",
                    updatedAt: now,
                };
                break;
            default:
                throw new Error(`Unsupported Workspace Goal action: ${String(action)}.`);
        }

        const goals = [...document.goals];
        goals[index] = next;
        return { document: this.compact({ goals, version: 1 }), result: snapshot(next, now) };
    }

    touch(document: GoalDocument, ctxId: string, kind: GoalActivityKind = "execution"): GoalTransition {
        const index = document.goals.findIndex((goal) => goal.createdByCtxId === ctxId);
        if (index === -1) return { document, result: undefined };
        const current = document.goals[index]!;
        if (current.status !== "active") return { document, result: snapshot(current, this.#now()) };
        const now = this.#now();
        const executionEvidence = kind !== "observation";
        const settled = settleAttemptedReentry(current, now);
        const next = {
            ...settled,
            lastAgentActivityAt: now,
            ...(executionEvidence ? { lastExecutionAt: now, noActionStreak: 0 } : {}),
        };
        const goals = [...document.goals];
        goals[index] = next;
        return { document: { goals, version: 1 }, result: snapshot(next, now) };
    }

    reentry(document: GoalDocument, ctxId: string, progressEpoch?: number): GoalTransition {
        const index = document.goals.findIndex((goal) => goal.createdByCtxId === ctxId);
        if (index === -1) return { document, result: undefined };
        const current = document.goals[index]!;
        if (current.status !== "active") return { document, result: snapshot(current, this.#now()) };
        const now = this.#now();
        const coveredProgressEpoch = validateReentryProgressEpoch(current, progressEpoch);
        if (current.reentryProgressEpoch !== undefined && coveredProgressEpoch <= current.reentryProgressEpoch) {
            return { document, result: snapshot(current, now) };
        }
        const evaluated = evaluatePreviousReentry(current);
        const next = {
            ...evaluated,
            lastReentryAt: now,
            reentryProgressEpoch: coveredProgressEpoch,
        };
        const goals = [...document.goals];
        goals[index] = next;
        return { document: { goals, version: 1 }, result: snapshot(next, now) };
    }

    continuation(
        document: GoalDocument,
        input: GoalContinuationInput,
        ctxId: string,
    ): GoalTransition<Record<string, unknown>> {
        const index = document.goals.findIndex((goal) => goal.createdByCtxId === ctxId);
        if (index === -1) {
            if (input.action === "claim") return { document, result: { claimed: false, goal: null } };
            if (input.action === "validate") return { document, result: { goal: null, valid: false } };
            if (input.action === "retire") return { document, result: { goal: null, retired: false } };
            throw new Error("No Workspace Goal is attached to the current Context.");
        }
        const now = this.#now();
        const current = expireStaleClaim(document.goals[index]!, now);
        if (input.goalId !== undefined && input.goalId !== current.goalId) {
            const goal = snapshot(current, now);
            if (input.action === "claim") return { document, result: { claimed: false, goal } };
            if (input.action === "validate") return { document, result: { goal, valid: false } };
            if (input.action === "retire") return { document, result: { goal, retired: false } };
            throw new Error(`Workspace Goal changed from ${input.goalId} to ${current.goalId}; refresh before retrying.`);
        }
        let next = current;
        let result: Record<string, unknown>;

        if (input.action === "retire") {
            next = clearContinuation(current);
            result = { goal: snapshot(next, now), retired: true };
        } else if (input.action === "reset") {
            next = {
                ...clearContinuation(current),
                continuationCount: 0,
                continuationRetryAfter: undefined,
                lastAgentActivityAt: now,
                noActionStreak: 0,
                stagnationStreak: 0,
            };
            result = { goal: snapshot(next, now), reset: true };
        } else if (input.action === "claim") {
            const claimId = requiredText(input.claimId, "claimId", 128);
            const state = snapshot(current, now);
            const eligible = input.userInitiated === true
                ? current.status === "active" && hasActionableStep(current.steps) && !state.continuationPending
                : state.continuationDue;
            if (input.available === false || !eligible) {
                result = { claimed: false, goal: state };
            } else {
                const evaluated = evaluatePreviousReentry(current);
                next = {
                    ...evaluated,
                    continuationClaimActivityAt: evaluated.lastAgentActivityAt,
                    continuationClaimedAt: now,
                    continuationClaimId: claimId,
                    continuationClaimProgressEpoch: goalProgressEpoch(evaluated),
                    continuationMessageId: `goal-message-${randomUUID()}`,
                    continuationPending: true,
                };
                result = {
                    claimed: true,
                    claimId,
                    continuationCount: current.continuationCount + 1,
                    goal: snapshot(next, now),
                };
            }
        } else if (input.action === "validate") {
            const claimId = requiredText(input.claimId, "claimId", 128);
            const valid = input.available !== false && claimMatches(current, claimId) &&
                current.status === "active" && current.continuationClaimActivityAt === current.lastAgentActivityAt;
            if (!valid && claimMatches(current, claimId)) next = clearContinuation(current);
            result = { goal: snapshot(next, now), valid };
        } else if (input.action === "attempt") {
            const claimId = requiredText(input.claimId, "claimId", 128);
            if (!claimMatches(current, claimId)) throw new Error("Workspace Goal continuation claim is no longer active.");
            if (input.available === false) {
                next = clearContinuation(current);
                result = { attempted: false, goal: snapshot(next, now) };
            } else if (current.continuationAttemptedAt === undefined) {
                next = { ...current, continuationAttemptedAt: now };
                result = {
                    attempted: true,
                    goal: snapshot(next, now),
                    ...(next.continuationMessageId === undefined ? {} : { messageId: next.continuationMessageId }),
                };
            } else {
                result = {
                    attempted: true,
                    goal: snapshot(next, now),
                    ...(next.continuationMessageId === undefined ? {} : { messageId: next.continuationMessageId }),
                };
            }
        } else if (input.action === "report") {
            const claimId = requiredText(input.claimId, "claimId", 128);
            if (!claimMatches(current, claimId)) throw new Error("Workspace Goal continuation claim is no longer active.");
            if (typeof input.accepted !== "boolean") throw new Error("accepted must be a boolean for continuation report.");
            if (input.accepted && current.continuationAttemptedAt === undefined) {
                throw new Error("Workspace Goal continuation was not marked attempted.");
            }
            next = {
                ...clearContinuation(current),
                continuationCount: current.continuationCount + (input.accepted ? 1 : 0),
                ...(input.accepted
                    ? {
                        continuationRetryAfter: undefined,
                        lastReentryAt: now,
                        reentryProgressEpoch: current.continuationClaimProgressEpoch ?? goalProgressEpoch(current),
                    }
                    : { continuationRetryAfter: new Date(Date.parse(now) + GOAL_CONTINUATION_RETRY_MS).toISOString() }),
            };
            result = { goal: snapshot(next, now) };
        } else if (input.action === "release") {
            const claimId = requiredText(input.claimId, "claimId", 128);
            if (!claimMatches(current, claimId)) throw new Error("Workspace Goal continuation claim is no longer active.");
            if (current.continuationAttemptedAt !== undefined) {
                throw new Error("Attempted Workspace Goal continuation cannot be released.");
            }
            next = clearContinuation(current);
            result = { goal: snapshot(next, now), released: true };
        } else {
            throw new Error(`Unsupported Workspace Goal continuation action: ${String(input.action)}.`);
        }

        const stored = document.goals[index]!;
        if (next === stored) return { document, result };
        const goals = [...document.goals];
        goals[index] = next;
        return { document: { goals, version: 1 }, result };
    }

    compact(document: GoalDocument, maxTerminalGoals = MAX_TERMINAL_GOALS): GoalDocument {
        const live = document.goals.filter((goal) => !isTerminalGoal(goal));
        const terminal = document.goals
            .filter(isTerminalGoal)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, Math.max(0, maxTerminalGoals));
        return {
            goals: [...live, ...terminal].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
            version: 1,
        };
    }

    #start(document: GoalDocument, input: GoalManageInput, ctxId: string): GoalTransition {
        const existing = document.goals.find((goal) => goal.createdByCtxId === ctxId);
        if (existing !== undefined && (existing.status === "active" || existing.status === "blocked" || existing.status === "paused")) {
            throw new Error(`Workspace Goal ${existing.goalId} is still ${existing.status}; finish or stop it first.`);
        }
        const now = this.#now();
        const steps = normalizeSteps(input.steps, true);
        const next: GoalRecord = {
            continuationCount: 0,
            continuationPending: false,
            createdAt: now,
            createdByCtxId: ctxId,
            goalId: this.#goalId(),
            lastAgentActivityAt: now,
            lastProgressAt: now,
            noActionStreak: 0,
            objective: requiredText(input.objective, "objective", GOAL_OBJECTIVE_LIMIT),
            progressEpoch: 0,
            revision: 1,
            stagnationStreak: 0,
            status: allStepsTerminal(steps) ? "completed" : "active",
            steps,
            updatedAt: now,
            ...(input.workspace === undefined ? {} : { workspace: requiredText(input.workspace, "workspace", 16_384) }),
        };
        const goals = document.goals.filter((goal) => goal.createdByCtxId !== ctxId);
        goals.push(next);
        return { document: this.compact({ goals, version: 1 }), result: snapshot(next, now) };
    }
}

function isTerminalGoal(goal: GoalRecord): boolean {
    return goal.status === "completed" || goal.status === "stopped";
}

function updateGoal(current: GoalRecord, input: GoalManageInput, now: string): GoalRecord {
    const settled = settleAttemptedReentry(current, now);
    let steps = current.steps.map((step) => ({ ...step }));
    if (input.steps !== undefined) steps = normalizeSteps(input.steps, true);
    if (input.stepId !== undefined) {
        const stepId = requiredText(input.stepId, "stepId", GOAL_STEP_ID_LIMIT);
        const index = steps.findIndex((step) => step.id === stepId);
        if (index === -1) throw new Error(`Workspace Goal step ${stepId} was not found.`);
        const previous = steps[index]!;
        steps[index] = {
            ...previous,
            ...(input.status === undefined ? {} : { status: normalizeStepStatus(input.status) }),
            ...(input.text === undefined ? {} : { text: requiredText(input.text, "text", GOAL_STEP_TEXT_LIMIT) }),
            ...(input.note === undefined ? {} : { note: requiredText(input.note, "note", GOAL_NOTE_LIMIT) }),
        };
        assertSingleActive(steps);
    }
    if (input.steps === undefined && input.stepId === undefined && input.objective === undefined && input.note === undefined) {
        throw new Error("workspace_goal update requires objective, steps, stepId, or note.");
    }
    const nextObjective = input.objective === undefined
        ? current.objective
        : requiredText(input.objective, "objective", GOAL_OBJECTIVE_LIMIT);
    const autoCompleted = allStepsTerminal(steps);
    const progressed = autoCompleted || nextObjective !== current.objective || goalStepsProgressed(current.steps, steps);
    const base = clearContinuation(settled);
    return {
        ...base,
        ...(progressed ? {
            continuationCount: 0,
            continuationRetryAfter: undefined,
            lastExecutionAt: now,
            lastProgressAt: now,
            noActionStreak: 0,
            progressEpoch: goalProgressEpoch(current) + 1,
            stagnationStreak: 0,
        } : {}),
        lastAgentActivityAt: now,
        ...(input.note === undefined ? {} : { note: requiredText(input.note, "note", GOAL_NOTE_LIMIT) }),
        objective: nextObjective,
        revision: current.revision + 1,
        status: autoCompleted ? "completed" : current.status,
        steps,
        updatedAt: now,
        ...(current.workspace === undefined && input.workspace !== undefined ? { workspace: input.workspace } : {}),
    };
}

function goalStepsProgressed(previous: GoalStep[], next: GoalStep[]): boolean {
    if (previous.length !== next.length) return true;
    return previous.some((step, index) => {
        const candidate = next[index];
        return candidate === undefined ||
            candidate.id !== step.id ||
            candidate.status !== step.status ||
            candidate.text !== step.text;
    });
}

function hasActionableStep(steps: GoalStep[]): boolean {
    return steps.some((step) => step.status === "active" || step.status === "pending");
}

function allStepsTerminal(steps: GoalStep[]): boolean {
    return steps.length > 0 && !hasActionableStep(steps);
}

function normalizeSteps(value: GoalStepInput[] | undefined, requireNonEmpty: boolean): GoalStep[] {
    if (!Array.isArray(value)) throw new Error("steps must be an array.");
    if (requireNonEmpty && value.length === 0) throw new Error("steps must contain at least one step.");
    if (value.length > GOAL_MAX_STEPS) throw new Error(`steps may contain at most ${GOAL_MAX_STEPS} entries.`);
    const ids = new Set<string>();
    const steps = value.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`steps[${index}] must be an object.`);
        const id = requiredText(entry.id, `steps[${index}].id`, GOAL_STEP_ID_LIMIT);
        if (ids.has(id)) throw new Error(`Workspace Goal step id must be unique: ${id}.`);
        ids.add(id);
        return {
            id,
            ...(entry.note === undefined ? {} : { note: requiredText(entry.note, `steps[${index}].note`, GOAL_NOTE_LIMIT) }),
            status: entry.status === undefined ? "pending" : normalizeStepStatus(entry.status),
            text: requiredText(entry.text, `steps[${index}].text`, GOAL_STEP_TEXT_LIMIT),
        };
    });
    assertSingleActive(steps);
    return steps;
}

function assertSingleActive(steps: GoalStep[]): void {
    if (steps.filter((step) => step.status === "active").length > 1) {
        throw new Error("Workspace Goal may have at most one active step.");
    }
}

function normalizeStepStatus(value: unknown): GoalStepStatus {
    if (value === "pending" || value === "active" || value === "completed" || value === "skipped") return value;
    throw new Error("Goal step status must be pending, active, completed, or skipped.");
}

function normalizeStoredGoal(value: unknown): GoalRecord {
    if (!isRecord(value)) throw new Error("goal state must be an object");
    const steps = normalizeSteps(value.steps as GoalStepInput[], true);
    const storedStatus = normalizeGoalStatus(value.status);
    const legacyAutoCompleted = storedStatus === "active" && allStepsTerminal(steps);
    const record: GoalRecord = {
        continuationCount: nonNegativeInteger(value.continuationCount, "continuationCount"),
        continuationPending: value.continuationPending === true,
        createdAt: requiredStoredString(value.createdAt, "createdAt"),
        createdByCtxId: requiredStoredString(value.createdByCtxId, "createdByCtxId"),
        goalId: requiredStoredString(value.goalId, "goalId"),
        lastAgentActivityAt: requiredStoredString(value.lastAgentActivityAt, "lastAgentActivityAt"),
        ...(typeof value.lastControlAt === "string" && value.lastControlAt.length > 0 ? { lastControlAt: value.lastControlAt } : {}),
        ...(typeof value.lastExecutionAt === "string" && value.lastExecutionAt.length > 0 ? { lastExecutionAt: value.lastExecutionAt } : {}),
        ...(typeof value.lastReentryAt === "string" && value.lastReentryAt.length > 0
            ? { lastReentryAt: value.lastReentryAt }
            : typeof value.lastContinuationAt === "string" && value.lastContinuationAt.length > 0
                ? { lastReentryAt: value.lastContinuationAt }
                : {}),
        lastProgressAt: typeof value.lastProgressAt === "string" && value.lastProgressAt.length > 0
            ? value.lastProgressAt
            : requiredStoredString(value.lastAgentActivityAt, "lastAgentActivityAt"),
        noActionStreak: optionalNonNegativeInteger(value.noActionStreak),
        objective: requiredText(value.objective, "objective", GOAL_OBJECTIVE_LIMIT),
        progressEpoch: optionalNonNegativeInteger(value.progressEpoch),
        revision: positiveInteger(value.revision, "revision"),
        stagnationStreak: optionalNonNegativeInteger(value.stagnationStreak),
        status: legacyAutoCompleted ? "completed" : storedStatus,
        steps,
        updatedAt: requiredStoredString(value.updatedAt, "updatedAt"),
        ...(typeof value.workspace === "string" && value.workspace.length > 0 ? { workspace: value.workspace } : {}),
    };
    for (const key of ["continuationAttemptedAt", "continuationClaimActivityAt", "continuationClaimedAt", "continuationClaimId", "continuationMessageId", "continuationRetryAfter", "lastStreakEvaluatedReentryAt", "note"] as const) {
        const field = value[key];
        if (typeof field === "string" && field.length > 0) record[key] = field;
    }
    if (typeof value.reentryProgressEpoch === "number") {
        record.reentryProgressEpoch = nonNegativeInteger(value.reentryProgressEpoch, "reentryProgressEpoch");
    } else if (record.lastReentryAt !== undefined) {
        record.reentryProgressEpoch = goalProgressEpoch(record);
    }
    if (typeof value.continuationClaimProgressEpoch === "number") {
        record.continuationClaimProgressEpoch = nonNegativeInteger(value.continuationClaimProgressEpoch, "continuationClaimProgressEpoch");
    }
    return legacyAutoCompleted
        ? {
            ...clearContinuation(record),
            continuationCount: 0,
            noActionStreak: 0,
            stagnationStreak: 0,
        }
        : record;
}

function normalizeGoalStatus(value: unknown): GoalRecord["status"] {
    if (value === "active" || value === "blocked" || value === "paused" || value === "completed" || value === "stopped") return value;
    throw new Error("invalid Workspace Goal status");
}

function snapshot(record: GoalRecord, now: string): GoalSnapshot {
    const nowMs = Date.parse(now);
    const executionMs = record.lastExecutionAt === undefined ? Date.parse(record.lastProgressAt) : Date.parse(record.lastExecutionAt);
    const controlMs = record.lastControlAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(record.lastControlAt);
    const reentryMs = record.lastReentryAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(record.lastReentryAt);
    const dueAtMs = Math.max(executionMs, controlMs, reentryMs) + GOAL_EXECUTION_LEASE_MS;
    const uncertain = record.continuationPending && record.continuationAttemptedAt !== undefined;
    const claimFresh = uncertain || (record.continuationPending && record.continuationClaimedAt !== undefined &&
        nowMs - Date.parse(record.continuationClaimedAt) < GOAL_CONTINUATION_CLAIM_TTL_MS);
    const retryReady = record.continuationRetryAfter === undefined || nowMs >= Date.parse(record.continuationRetryAfter);
    const progressEpoch = goalProgressEpoch(record);
    const reentryProgressEpoch = record.reentryProgressEpoch ??
        (record.lastReentryAt === undefined ? undefined : progressEpoch);
    const progressedSinceReentry = reentryProgressEpoch === undefined || progressEpoch > reentryProgressEpoch;
    return {
        autoContinueExhausted: false,
        ...(record.continuationAttemptedAt === undefined ? {} : { continuationAttemptedAt: record.continuationAttemptedAt }),
        continuationCount: record.continuationCount,
        ...(record.continuationMessageId === undefined ? {} : { continuationMessageId: record.continuationMessageId }),
        continuationDue: record.status === "active" && hasActionableStep(record.steps) && progressedSinceReentry &&
            !claimFresh && retryReady && nowMs >= dueAtMs,
        continuationDueAt: new Date(dueAtMs).toISOString(),
        continuationPending: claimFresh,
        ...(record.continuationRetryAfter === undefined ? {} : { continuationRetryAfter: record.continuationRetryAfter }),
        continuationUncertain: uncertain,
        createdAt: record.createdAt,
        goalId: record.goalId,
        lastAgentActivityAt: record.lastAgentActivityAt,
        ...(record.lastExecutionAt === undefined ? {} : { lastExecutionAt: record.lastExecutionAt }),
        ...(record.lastReentryAt === undefined ? {} : { lastReentryAt: record.lastReentryAt, lastContinuationAt: record.lastReentryAt }),
        lastProgressAt: record.lastProgressAt,
        maxContinuations: GOAL_MAX_CONTINUATIONS,
        noActionStreak: record.noActionStreak,
        progressEpoch,
        stagnationStreak: record.stagnationStreak,
        ...(record.note === undefined ? {} : { note: record.note }),
        objective: record.objective,
        revision: record.revision,
        status: record.status,
        steps: record.steps.map((step) => ({ ...step })),
        updatedAt: record.updatedAt,
        ...(record.workspace === undefined ? {} : { workspace: record.workspace }),
    };
}

function evaluatePreviousReentry(record: GoalRecord): GoalRecord {
    const reentryAt = record.lastReentryAt;
    if (reentryAt === undefined || record.lastStreakEvaluatedReentryAt === reentryAt) return record;
    const reentryMs = Date.parse(reentryAt);
    const executionMs = record.lastExecutionAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(record.lastExecutionAt);
    const reentryProgressEpoch = record.reentryProgressEpoch ?? goalProgressEpoch(record);
    if (goalProgressEpoch(record) > reentryProgressEpoch) {
        return {
            ...record,
            lastStreakEvaluatedReentryAt: reentryAt,
            noActionStreak: 0,
            stagnationStreak: 0,
        };
    }
    if (executionMs > reentryMs) {
        return {
            ...record,
            lastStreakEvaluatedReentryAt: reentryAt,
            noActionStreak: 0,
            stagnationStreak: record.stagnationStreak + 1,
        };
    }
    return {
        ...record,
        lastStreakEvaluatedReentryAt: reentryAt,
        noActionStreak: record.noActionStreak + 1,
    };
}

function expireStaleClaim(record: GoalRecord, now: string): GoalRecord {
    if (!record.continuationPending || record.continuationClaimedAt === undefined) return record;
    if (record.continuationAttemptedAt !== undefined) return record;
    if (Date.parse(now) - Date.parse(record.continuationClaimedAt) < GOAL_CONTINUATION_CLAIM_TTL_MS) return record;
    return clearContinuation(record);
}

function clearContinuation(record: GoalRecord): GoalRecord {
    const {
        continuationAttemptedAt: _attemptedAt,
        continuationClaimActivityAt: _activity,
        continuationClaimedAt: _claimedAt,
        continuationClaimId: _claimId,
        continuationClaimProgressEpoch: _progressEpoch,
        continuationMessageId: _messageId,
        ...rest
    } = record;
    return { ...rest, continuationPending: false };
}

function claimMatches(record: GoalRecord, claimId: string): boolean {
    return record.continuationPending && record.continuationClaimId === claimId;
}

function goalProgressEpoch(record: GoalRecord): number {
    return record.progressEpoch ?? 0;
}

function validateReentryProgressEpoch(record: GoalRecord, value: number | undefined): number {
    const current = goalProgressEpoch(record);
    if (value === undefined) return current;
    if (!Number.isSafeInteger(value) || value < 0 || value > current) {
        throw new Error(`Workspace Goal re-entry progress epoch ${value} is invalid for current epoch ${current}.`);
    }
    return value;
}

function settleAttemptedReentry(record: GoalRecord, now: string): GoalRecord {
    if (!record.continuationPending || record.continuationAttemptedAt === undefined) {
        return clearContinuation(record);
    }
    const coveredProgressEpoch = record.continuationClaimProgressEpoch ?? goalProgressEpoch(record);
    const previousCovered = record.reentryProgressEpoch;
    return {
        ...clearContinuation(record),
        continuationCount: record.continuationCount + 1,
        ...(previousCovered !== undefined && previousCovered >= coveredProgressEpoch ? {} : {
            lastReentryAt: now,
            reentryProgressEpoch: coveredProgressEpoch,
        }),
    };
}

function requiredText(value: unknown, field: string, limit: number): string {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string.`);
    const normalized = value.trim();
    if (normalized.length > limit) throw new Error(`${field} exceeds ${limit} characters.`);
    return normalized;
}

function requiredStoredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string.`);
    return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer.`);
    return value;
}

function optionalNonNegativeInteger(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer.`);
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
