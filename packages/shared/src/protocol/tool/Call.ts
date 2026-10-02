import type { InstanceName } from "../instance/Identity.js";
import type { JsonValue } from "../JsonValue.js";

export type ToolCallSource = "cli" | "tui" | "web" | "mcp" | "extension";

export interface ToolCallContext {
    requestId?: string;
    operationId?: string;
    ctxId?: string;
    workspace?: string;
    source: ToolCallSource;
}

export interface ToolCallProvenance {
    explanation?: string;
    purpose?: string;
}

export type ToolCallStatus =
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "denied"
    | "queueTimeout"
    | "cancelled";

export type ToolCallFailureStage = "postExecution" | "outboundHook";

export interface ToolCallQuery {
    after?: string;
    before?: string;
    callIds?: string[];
    ctxId?: string;
    includeInput?: boolean;
    includeOutput?: boolean;
    limit?: number;
    maxBytes?: number;
    source?: ToolCallSource;
    status?: ToolCallStatus;
    toolName?: string;
    workspace?: string;
}

export interface ToolCallRecord extends ToolCallProvenance {
    callId: string;
    completedAt?: string;
    error?: string;
    executionCompleted?: boolean;
    exitCode?: number | null;
    failureStage?: ToolCallFailureStage;
    inputSummary: string;
    input?: JsonValue;
    output?: JsonValue;
    instance: InstanceName;
    requestId?: string;
    ctxId?: string;
    source: ToolCallSource;
    startedAt: string;
    status: ToolCallStatus;
    stderrBytes?: number;
    stdoutBytes?: number;
    termSignal?: number;
    termination?: ToolTermination;
    toolName: string;
    workspace?: string;
}

export type ToolTermination = "exited" | "signaled" | "timeout";
