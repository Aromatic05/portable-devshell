import type { ContextMessageStatus } from "./ContextMessage.js";

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

export const CONVERSATION_PREFERENCES_VERSION = 1 as const;

export interface ConversationPreferencesSnapshot {
    hiddenContexts: Record<string, true>;
    orderByWorkspace: Record<string, string[]>;
    titles: Record<string, string>;
    version: typeof CONVERSATION_PREFERENCES_VERSION;
    workspaceOrder: string[];
}

export interface ConversationPreferencesPatch {
    hiddenContexts?: Record<string, true | null>;
    ifMissing?: boolean;
    orderByWorkspace?: Record<string, string[]>;
    titles?: Record<string, string | null>;
    workspaceOrder?: string[];
}

export function createEmptyConversationPreferences(): ConversationPreferencesSnapshot {
    return {
        hiddenContexts: {},
        orderByWorkspace: {},
        titles: {},
        version: CONVERSATION_PREFERENCES_VERSION,
        workspaceOrder: [],
    };
}
