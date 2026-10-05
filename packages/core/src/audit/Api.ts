import type { StateStore } from "./database/index.js";
import type { AuditEventStore } from "./event/index.js";
import type { LogStoreInstance } from "./log/index.js";
import type { AuditToolCallStore } from "./toolcall/index.js";

export type AuditEvents = Pick<
    AuditEventStore,
    "append" | "readFrom" | "readTail" | "readHighWater"
>;
export type AuditLogs = Pick<LogStoreInstance, "append" | "read">;
export type AuditToolCalls = Pick<
    AuditToolCallStore,
    "append" | "hasCall" | "readQuery" | "readFailureSummary"
>;

export interface AuditApi {
    readonly events: AuditEvents;
    readonly logs: AuditLogs;
    readonly toolCalls: AuditToolCalls;
    state<TValue>(namespace: string): StateStore<TValue>;
}
