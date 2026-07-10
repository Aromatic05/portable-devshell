import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";

export type ToolCallSource = "cli" | "tui" | "mcp";
export type ControlClientKind = ToolCallSource | "unknown";

export interface ToolCallContext {
    purpose?: string;
    requestId?: string;
    sessionId?: string;
    source: ToolCallSource;
}

export type ToolCallStatus = "queued" | "pendingApproval" | "running" | "completed" | "failed" | "denied" | "expired" | "queueTimeout" | "cancelled";

export type ToolCallApprovalDecision = "approved" | "denied" | "expired";

export interface ToolCallQuery {
    after?: string;
    before?: string;
    limit?: number;
    source?: ToolCallSource;
    status?: ToolCallStatus;
    toolName?: string;
}

export interface ToolCallRecord {
    callId: string;
    completedAt?: string;
    decision?: ToolCallApprovalDecision;
    error?: string;
    exitCode?: number | null;
    inputSummary: string;
    instance: InstanceName;
    approvalId?: string;
    requestId?: string;
    sessionId?: string;
    source: ToolCallSource;
    startedAt: string;
    status: ToolCallStatus;
    stderrBytes?: number;
    stdoutBytes?: number;
    termSignal?: number;
    termination?: ToolTermination;
    toolName: string;
}

export type ToolTermination = "exited" | "signaled" | "timeout" | "outputLimit";
