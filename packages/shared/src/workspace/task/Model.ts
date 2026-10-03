import { type JsonValue } from "../../types/Json.js";

// Workspace goal records. Goals are read as an authoritative snapshot plus the
// instance event sequence at read time, so a reader can subscribe from the
// cursor without a list-then-subscribe race.

export type GoalStepStatus = "pending" | "active" | "completed" | "skipped";
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
    lastProgressAt: string;
    lastStreakEvaluatedReentryAt?: string;
    noActionStreak?: number;
    progressEpoch?: number;
    stagnationStreak?: number;
    note?: string;
    objective: string;
    revision: number;
    status: GoalStatus;
    steps: GoalStep[];
    updatedAt: string;
    workspace?: string;
}
export interface GoalSnapshotEnvelope {
    goals: GoalSnapshot[];
    lastSeq: number;
}
/** Instance activity events that change the goal projection. */
export function isGoalEvent(type: string): boolean {
    return type.startsWith("goal.");
}
// Todo task model. A todo read is an authoritative snapshot plus the instance
// event sequence at read time; callers subscribe from lastSeq + 1 to close the
// list-then-subscribe window.

export const TODO_MAX_ARCHIVED = 256;
export const TODO_MAX_ITEMS = 100;
export const TODO_MAX_TEXT_LENGTH = 4_000;
export const TODO_MAX_TITLE_LENGTH = 256;
export const TODO_MAX_ID_LENGTH = 128;
export const TODO_MAX_CHECKPOINT_BLOCKERS = 32;
export type TodoStatus =
    | "pending"
    | "in_progress"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";
export type TodoTaskStatus = TodoStatus | "none" | "paused";
export type TodoTaskControlAction = "pause" | "resume" | "cancel";
export interface TodoCheckpointInput {
    blockers?: string[];
    next?: string;
    summary: string;
}
export interface TodoCheckpoint extends TodoCheckpointInput {
    updatedAt: string;
}
export interface TodoItem {
    content: string;
    detail?: string;
    id: string;
    status: TodoStatus;
}
export interface TodoSummary {
    completed: number;
    currentItemId?: string;
    total: number;
}
export interface ActiveTodoSummary {
    completed: number;
    checkpoint?: TodoCheckpoint;
    currentItem?: string;
    pausedAt?: string;
    revision: number;
    status: TodoTaskStatus;
    taskId: string;
    title: string;
    total: number;
}
export interface TodoState {
    activeCtxId?: string;
    archivedAt?: string;
    cancelledAt?: string;
    checkpoint?: TodoCheckpoint;
    createdAt: string;
    createdByCtxId: string;
    items: TodoItem[];
    originInstance: string;
    pausedAt?: string;
    revision: number;
    taskId: string;
    title: string;
    updatedAt: string;
}
export interface TodoReadResult {
    cancelledAt?: string;
    checkpoint?: TodoCheckpoint;
    items: TodoItem[];
    pausedAt?: string;
    revision: number;
    summary: TodoSummary;
    taskId?: string;
    title?: string;
    tasks?: TodoTaskSummary[];
}
export interface TodoReadInput {
    taskId?: string;
    title?: string;
}
export interface TodoTaskSummary extends ActiveTodoSummary {
    ctxId?: string;
    updatedAt: string;
}
export interface TodoWriteInput {
    checkpoint?: TodoCheckpointInput;
    revision: number;
    taskId?: string;
    title: string;
    todos: TodoItem[];
}
export interface TodoReadEnvelope {
    lastSeq: number;
    todo: TodoReadResult;
}
export function isTodoEvent(type: string): boolean {
    return type.startsWith("todo.");
}
export type WaitKind = "approval" | "question" | "tmux";
export type WaitStatus =
    | "waiting"
    | "detached"
    | "resolved"
    | "consumed"
    | "cancelled";
export interface WaitCreateInput {
    automaticRecovery?: boolean;
    createdByCtxId: string;
    deadlineAt?: string;
    goalId?: string;
    goalProgressAt?: string;
    goalProgressEpoch?: number;
    goalRevision?: number;
    goalStepId?: string;
    kind: WaitKind;
    ownerCallId?: string;
    payload?: JsonValue;
    targetInstance?: string;
    targetId: string;
    taskId?: string;
    taskRevision?: number;
    todoItemId?: string;
    workspace?: string;
}
export interface WaitRecord extends WaitCreateInput {
    cancelledAt?: string;
    consumedAt?: string;
    createdAt: string;
    detachedAt?: string;
    recoveryClaimedAt?: string;
    recoveryClaimId?: string;
    recoveryDisabledAt?: string;
    recoveryDismissedAt?: string;
    recoveryGoalProgressEpoch?: number;
    recoveryMessageAttemptedAt?: string;
    recoveryMessageId?: string;
    recoveryMessageSentAt?: string;
    resolvedAt?: string;
    result?: JsonValue;
    status: WaitStatus;
    updatedAt: string;
    waitId: string;
}
