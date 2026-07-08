import type { InstanceName } from "../../type/identity/TypeIdentityInstanceName.js";
import type { CommandResult } from "../DtoCommandResult.js";

export type ToolCallSource = "cli" | "tui" | "mcp";

export interface ToolCallContext {
    requestId?: string;
    sessionId?: string;
    source: ToolCallSource;
}

export type ToolCallStatus = "completed" | "failed";

export interface ToolCallRecord {
    args: string[];
    callId: string;
    errorCode?: string;
    finishedAt?: string;
    instanceName: InstanceName;
    requestId?: string;
    result?: CommandResult;
    sessionId?: string;
    source: ToolCallSource;
    startedAt: string;
    status: ToolCallStatus;
    toolName: string;
}
