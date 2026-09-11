import type { ContextMessageStatus } from "./DtoContextMessage.js";

export type ConversationEntryKind = "comment" | "report";

export interface ConversationEntry {
    callId?: string;
    createdAt: string;
    ctxId: string;
    deliveredAt?: string;
    error?: string;
    failedAt?: string;
    id: string;
    kind: ConversationEntryKind;
    status?: ContextMessageStatus;
    text: string;
}

export interface ConversationListInput {
    before?: string;
    ctxId?: string;
    limit?: number;
    maxBytes?: number;
}
