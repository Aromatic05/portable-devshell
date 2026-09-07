import type { ToolCallSource } from "../tool/DtoToolCallRecord.js";

export interface InstanceLogEntry {
    at: string;
    callId?: string;
    ctxId?: string;
    extensionId?: string;
    instanceName: string;
    message: string;
    requestId?: string;
    seq: number;
    source?: ToolCallSource;
    stream: "stderr" | "stdout";
    toolName?: string;
}
