import type {
    InstanceName,
    InstanceEventRecord,
    ToolCallQuery,
    ToolCallRecord,
    ToolCallSource,
} from "@portable-devshell/shared";

export interface InstanceLogEntry {
    at: string;
    callId?: string;
    instanceName: InstanceName;
    message: string;
    requestId?: string;
    seq: number;
    ctxId?: string;
    source?: ToolCallSource;
    stream: "stderr" | "stdout";
    toolName?: string;
}

export interface LogQuery {
    callId?: string;
    ctxId?: string;
    fromSeq?: number;
    limit?: number;
    maxDecodedBytes?: number;
}

export interface StateStore<TValue> {
    put(key: string, value: TValue): Promise<void>;
    get(key: string): Promise<TValue | undefined>;
    list(): Promise<TValue[]>;
    delete(key: string): Promise<void>;
}

export interface AuditToolCallFailureSummary {
    count: number;
    latest?: ToolCallRecord;
}

export interface AuditEvents {
    append(record: InstanceEventRecord): Promise<void>;
    readFrom(fromSeq: number, limit?: number): InstanceEventRecord[];
    readTail(limit: number): InstanceEventRecord[];
    readHighWater(): number;
}

export interface AuditLogs {
    append(
        stream: InstanceLogEntry["stream"],
        message: string,
        at: string,
        context?: Pick<
            InstanceLogEntry,
            "callId" | "requestId" | "ctxId" | "source" | "toolName"
        >,
    ): Promise<InstanceLogEntry>;
    read(query?: LogQuery): Promise<InstanceLogEntry[]>;
}

export interface AuditToolCalls {
    append(record: ToolCallRecord): Promise<void>;
    hasCall(callId: string): boolean;
    readQuery(query?: ToolCallQuery, options?: { deferFirstByteLimit: boolean }): ToolCallRecord[];
    readFailureSummary(
        sinceMs: number,
        untilMs: number,
    ): AuditToolCallFailureSummary;
}

export interface AuditApi {
    readonly events: AuditEvents;
    readonly logs: AuditLogs;
    readonly toolCalls: AuditToolCalls;
    state<TValue>(namespace: string): StateStore<TValue>;
}

export interface AuditRuntimeOptions {
    instanceName: InstanceName;
    filePath: string;
    eventBufferSize: number;
    limits?: Partial<AuditStorageLimits>;
    now?: () => number;
}

export interface AuditRuntime {
    readonly api: AuditApi;
    close(): Promise<void>;
}

export interface AuditStorageLimits {
    maxBytes: number;
    retentionDays: number;
}
