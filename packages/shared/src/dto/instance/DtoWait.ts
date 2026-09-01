import type { JsonValue } from "../../type/TypeJsonValue.js";

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
    recoveryMessageAttemptedAt?: string;
    recoveryMessageId?: string;
    recoveryMessageSentAt?: string;
    recoveryRetryAfter?: string;
    recoveryRetryCount?: number;
    resolvedAt?: string;
    result?: JsonValue;
    status: WaitStatus;
    updatedAt: string;
    waitId: string;
}
