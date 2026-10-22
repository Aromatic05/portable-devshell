import type { InstanceEventRecord } from "../../client/Stream.js";
import type { InstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";
import type { ToolCallContext } from "../../execution/toolcall/Type.js";

export type TaskEventType =
    | "goal.updated"
    | "wait.detached"
    | "wait.resolved"
    | "wait.failed";
export type TaskEvent = InstanceEventRecord<TaskEventType>;
export function isTaskEventType(type: string): type is TaskEventType {
    return isGoalEvent(type) || isWaitEvent(type);
}

// Workspace goal records. Goals are read as an authoritative snapshot plus the
// instance event sequence at read time, so a reader can subscribe from the
// cursor without a list-then-subscribe race.

export type GoalStatus =
    "active" | "blocked" | "paused" | "completed" | "stopped";
export type GoalAction =
    | "start"
    | "get"
    | "update"
    | "block"
    | "pause"
    | "resume"
    | "finish"
    | "stop";
export type GoalActivityKind =
    "observation" | "execution" | "mutation" | "wait";
export type GoalContinuationAction =
    | "claim"
    | "validate"
    | "attempt"
    | "report"
    | "release"
    | "reset"
    | "retire";
export interface GoalManageInput {
    action: GoalAction;
    expectedGoalId?: string;
    expectedRevision?: number;
    note?: string;
    objective?: string;
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
    goalId?: string;
    userInitiated?: boolean;
}
export interface GoalRecord {
    continuationAttemptedAt?: string;
    continuationClaimActivityAt?: string;
    continuationClaimedAt?: string;
    continuationClaimId?: string;
    continuationClaimProgressEpoch?: number;
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
    lastProgressAt: string;
    lastStreakEvaluatedReentryAt?: string;
    noActionStreak: number;
    progressEpoch?: number;
    reentryProgressEpoch?: number;
    stagnationStreak: number;
    note?: string;
    objective: string;
    revision: number;
    status: GoalStatus;
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
    lastProgressAt: string;
    lastStreakEvaluatedReentryAt?: string;
    noActionStreak?: number;
    progressEpoch?: number;
    stagnationStreak?: number;
    note?: string;
    objective: string;
    revision: number;
    status: GoalStatus;
    updatedAt: string;
    workspace?: string;
}
export interface GoalSnapshotEnvelope {
    goals: GoalSnapshot[];
    lastSeq: number;
}
/** Instance activity events that change the goal projection. */
export function isGoalEvent(
    type: string,
): type is Extract<TaskEventType, `goal.${string}`> {
    return type.startsWith("goal.");
}
export function isWaitEvent(
    type: string,
): type is Extract<TaskEventType, `wait.${string}`> {
    return type.startsWith("wait.");
}

export type WaitStatus = "detached" | "resolved" | "failed";

export interface WaitDetachInput {
    callId: string;
    ctxId?: string;
    instance: InstanceName;
    source: ToolCallContext["source"];
    targetId: string;
    toolName: string;
    workspace?: string;
}

export interface WaitRecord extends WaitDetachInput {
    createdAt: string;
    error?: string;
    resolvedAt?: string;
    result?: JsonValue;
    status: WaitStatus;
    updatedAt: string;
    waitId: string;
}
