import type { InstanceName, ToolCallSource } from "@portable-devshell/shared";

export interface InstanceLogEntry {
    at: string;
    callId?: string;
    instanceName: InstanceName;
    message: string;
    requestId?: string;
    seq: number;
    ctxId?: string;
    extensionId?: string;
    source?: ToolCallSource;
    stream: "stderr" | "stdout";
    toolName?: string;
}
