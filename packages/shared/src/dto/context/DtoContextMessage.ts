export type ContextMessageStatus = "pending" | "sent" | "delivered" | "failed";

export interface ContextMessageRecord {
    createdAt: string;
    ctxId: string;
    deliveredAt?: string;
    error?: string;
    failedAt?: string;
    id: string;
    instance: string;
    status: ContextMessageStatus;
    text: string;
}

export interface ContextMessageQueueInput {
    ctxId: string;
    text: string;
}

export interface ContextMessageListInput {
    ctxId?: string;
}

export interface ContextMessageReadResult {
    messages: Array<Pick<ContextMessageRecord, "createdAt" | "id" | "text">>;
}
