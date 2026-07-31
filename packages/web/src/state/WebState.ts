import type {
    ApprovalRequest,
    ContextMessageRecord,
    InstanceListEntry,
    InstanceLogEntry,
    OAuthApprovalRequest,
    OperationalOverview,
    TodoReadResult,
    ToolCallRecord,
} from "@portable-devshell/shared/browser";

export type ConnectionState = "connecting" | "online" | "offline";

export interface WebState {
    approvals: Record<string, ApprovalRequest[]>;
    connection: ConnectionState;
    contextMessages: Record<string, ContextMessageRecord[]>;
    error?: string;
    instances: InstanceListEntry[];
    logs: Record<string, InstanceLogEntry[]>;
    notice?: string;
    oauthApprovals: OAuthApprovalRequest[];
    operations: Record<string, "pending">;
    overview?: OperationalOverview;
    partialFailures: Record<string, string>;
    service?: { instanceCount: number; ok: boolean; pid?: number };
    todos: Record<string, TodoReadResult>;
    toolCalls: Record<string, ToolCallRecord[]>;
}

export function createInitialWebState(): WebState {
    return {
        approvals: {},
        connection: "connecting",
        contextMessages: {},
        instances: [],
        logs: {},
        oauthApprovals: [],
        operations: {},
        partialFailures: {},
        todos: {},
        toolCalls: {},
    };
}
