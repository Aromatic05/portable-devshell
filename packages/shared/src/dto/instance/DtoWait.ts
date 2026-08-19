import type { JsonValue } from "../../type/TypeJsonValue.js";

export type WaitKind = "approval" | "question" | "tmux";

export type WaitStatus =
    | "waiting"
    | "detached"
    | "resolved"
    | "consumed"
    | "cancelled";

export interface WaitCreateInput {
    createdByCtxId: string;
    kind: WaitKind;
    ownerCallId?: string;
    payload?: JsonValue;
    targetId: string;
    taskId?: string;
}

export interface WaitRecord extends WaitCreateInput {
    cancelledAt?: string;
    consumedAt?: string;
    createdAt: string;
    detachedAt?: string;
    recoveryClaimedAt?: string;
    recoveryClaimId?: string;
    resolvedAt?: string;
    result?: JsonValue;
    status: WaitStatus;
    updatedAt: string;
    waitId: string;
}
