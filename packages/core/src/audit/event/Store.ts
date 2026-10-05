import type { InstanceEventRecord } from "@portable-devshell/shared";
import type { AuditDatabase } from "../database/Database.js";
import type { AuditSequenceStore } from "../RecordStore.js";

export class AuditEventStore {
    #closing = false;
    readonly #store: AuditSequenceStore<InstanceEventRecord>;

    constructor(database: AuditDatabase, capacity: number) {
        this.#store = database.store<InstanceEventRecord>("events", {
            maxRecords: capacity,
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        });
    }

    append(record: InstanceEventRecord): Promise<void> {
        if (this.#closing) return Promise.reject(new Error("Audit record store is closing."));
        return this.#store.append(record);
    }

    readFrom(fromSeq: number, limit?: number): InstanceEventRecord[] {
        return this.#store.readFromSeq(fromSeq, limit);
    }

    readTail(limit: number): InstanceEventRecord[] {
        return this.#store.readTail(limit);
    }

    readHighWater(): number {
        return this.#store.readHighWater();
    }

    close(): void {
        this.#closing = true;
    }

}
