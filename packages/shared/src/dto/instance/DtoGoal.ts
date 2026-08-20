export type GoalStepStatus = "pending" | "active" | "completed" | "skipped";
export type GoalStatus = "active" | "blocked" | "completed" | "stopped";
export type GoalAction = "start" | "get" | "update" | "block" | "resume" | "finish" | "stop";
export type GoalContinuationAction = "claim" | "validate" | "report";

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
    note?: string;
    objective?: string;
    status?: GoalStepStatus;
    stepId?: string;
    steps?: GoalStepInput[];
    text?: string;
}

export interface GoalContinuationInput {
    accepted?: boolean;
    action: GoalContinuationAction;
    available?: boolean;
    claimId?: string;
    error?: string;
}

export interface GoalRecord {
    continuationClaimActivityAt?: string;
    continuationClaimedAt?: string;
    continuationClaimId?: string;
    continuationCount: number;
    continuationPending: boolean;
    continuationRetryAfter?: string;
    createdAt: string;
    createdByCtxId: string;
    goalId: string;
    lastAgentActivityAt: string;
    lastContinuationAt?: string;
    note?: string;
    objective: string;
    revision: number;
    status: GoalStatus;
    steps: GoalStep[];
    updatedAt: string;
}

export interface GoalSnapshot {
    autoContinueExhausted: boolean;
    continuationCount: number;
    continuationDue: boolean;
    continuationDueAt: string;
    continuationPending: boolean;
    continuationRetryAfter?: string;
    createdAt: string;
    goalId: string;
    lastAgentActivityAt: string;
    lastContinuationAt?: string;
    maxContinuations: number;
    note?: string;
    objective: string;
    revision: number;
    status: GoalStatus;
    steps: GoalStep[];
    updatedAt: string;
}
