export interface InstanceLogEntry {
    at: string;
    callId?: string;
    ctxId?: string;
    instanceName: string;
    message: string;
    requestId?: string;
    seq: number;
    source?: "cli" | "mcp" | "tui";
    stream: "stderr" | "stdout";
    toolName?: string;
}
