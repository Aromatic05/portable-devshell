import type { ToolCallQuery, ToolCallRecord } from "@portable-devshell/shared";
import type { AuditDatabase, AuditToolCallRecordStore } from "../database/index.js";

export class AuditToolCallStore {
    #closing = false;
    readonly #store: AuditToolCallRecordStore;

    constructor(database: AuditDatabase) {
        this.#store = database.toolCallStore({
            timestamp: (record) => record.completedAt ?? record.startedAt,
        });
    }

    append(record: ToolCallRecord): Promise<void> {
        if (this.#closing) return Promise.reject(new Error("Audit record store is closing."));
        return this.#store.append(record);
    }

    hasCall(callId: string): boolean {
        return this.#store.hasCall(callId);
    }

    readQuery(query: ToolCallQuery = {}): ToolCallRecord[] {
        return this.#store.readQuery(query);
    }

    readFailureSummary(sinceMs: number, untilMs: number) {
        return this.#store.readFailureSummary(sinceMs, untilMs);
    }

    close(): void {
        this.#closing = true;
    }

}
