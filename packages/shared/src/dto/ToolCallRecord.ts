import type { InstanceName } from "../types/InstanceName.js";
import type { CommandResult } from "./CommandResult.js";

export interface ToolCallRecord {
    args: string[];
    finishedAt?: string;
    instanceName: InstanceName;
    result?: CommandResult;
    startedAt: string;
    toolName: string;
}
