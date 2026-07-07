import type { InstanceName } from "../types/InstanceName.js";
import type { CommandResult } from "./CommandResult.js";

export type ToolCallStatus = "started" | "completed" | "failed";

export interface ToolCallRecord {
    args: string[];
    callId: string;
    errorCode?: string;
    finishedAt?: string;
    instanceName: InstanceName;
    result?: CommandResult;
    startedAt: string;
    status: ToolCallStatus;
    toolName: string;
}
