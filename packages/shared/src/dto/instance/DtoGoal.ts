export type GoalStepStatus = "pending" | "active" | "completed" | "skipped";
export type GoalStatus = "active" | "blocked" | "paused" | "completed" | "stopped";
export type GoalAction = "start" | "get" | "update" | "block" | "pause" | "resume" | "finish" | "stop";
export type GoalActivityKind = "observation" | "execution" | "mutation" | "wait";
export type GoalContinuationAction = "claim" | "validate" | "attempt" | "report" | "reset";

export interface GoalStep {
    id: string;
    note?: string;
    status: GoalStepStatus;
    text: string;
}

export interface GoalStepInput {
    id: string;
    note?: string;
    status?: GoalStepStatus;
    text: string;
}

export interface GoalManageInput {
    action: GoalAction;
    expectedGoalId?: string;
    expectedRevision?: number;
    note?: string;
    objective?: string;
    status?: GoalStepStatus;
    stepId?: string;
    steps?: GoalStepInput[];
    text?: string;
    /** Internal execution binding. Model-facing schemas do not expose this field. */
    workspace?: string;
    /** Internal human-control marker. Model-facing schemas do not expose this field. */
    userControl?: boolean;
}

export interface GoalContinuationInput {
    accepted?: boolean;
    action: GoalContinuationAction;
    available?: boolean;
    claimId?: string;
    error?: string;
}

export interface GoalRecord {
    continuationAttemptedAt?: string;
    continuationClaimActivityAt?: string;
    continuationClaimedAt?: string;
    continuationClaimId?: string;
    continuationCount: number;
    continuationMessageId?: string;
    continuationPending: boolean;
    continuationRetryAfter?: string;
    createdAt: string;
    createdByCtxId: string;
    goalId: string;
    lastAgentActivityAt: string;
    lastControlAt?: string;
    lastExecutionAt?: string;
    lastReentryAt?: string;
    /** Compatibility alias for lastReentryAt. */
    lastContinuationAt?: string;
    lastProgressAt: string;
    lastStreakEvaluatedReentryAt?: string;
    noActionStreak: number;
    stagnationStreak: number;
    note?: string;
    objective: string;
    revision: number;
    status: GoalStatus;
    steps: GoalStep[];
    updatedAt: string;
    workspace?: string;
}

export interface GoalSnapshot {
    autoContinueExhausted: boolean;
    continuationAttemptedAt?: string;
    continuationCount: number;
    continuationMessageId?: string;
    continuationDue: boolean;
    continuationDueAt: string;
    continuationPending: boolean;
    continuationRetryAfter?: string;
    continuationUncertain: boolean;
    createdAt: string;
    goalId: string;
    lastAgentActivityAt: string;
    lastExecutionAt?: string;
    lastReentryAt?: string;
    /** Compatibility alias for lastReentryAt. */
    lastContinuationAt?: string;
    lastProgressAt: string;
    lastStreakEvaluatedReentryAt?: string;
    noActionStreak?: number;
    stagnationStreak?: number;
    /** Compatibility field; 0 means automatic continuation is unbounded. */
    maxContinuations: number;
    note?: string;
    objective: string;
    revision: number;
    status: GoalStatus;
    steps: GoalStep[];
    updatedAt: string;
    workspace?: string;
}

export interface GoalRpcEnvelope {
    goals: GoalSnapshot[];
    lastSeq: number;
}
