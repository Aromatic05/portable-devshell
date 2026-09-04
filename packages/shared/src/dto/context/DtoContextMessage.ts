export type ContextMessageStatus = "pending" | "sent" | "delivered" | "failed";

export interface ContextMessageRecord {
    callId?: string;
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
    before?: string;
    ctxId?: string;
    limit?: number;
    maxBytes?: number;
}

export interface ContextMessageReadResult {
    callId: string;
    comment?: string;
    messages: Array<Pick<ContextMessageRecord, "createdAt" | "id" | "text">>;
}
