import type { InstanceName } from "@portable-devshell/shared";
import { AuditDatabase, type StateStore } from "./database/Database.js";
import { resolveAuditStorageLimits, type AuditStorageLimits } from "./database/Limits.js";
import { AuditEventStore } from "./event/Store.js";
import { LogStoreInstance } from "./log/Store.js";
import type { InstanceLogEntry } from "./log/Entry.js";
import { AuditToolCallStore } from "./toolcall/Store.js";

export interface InstanceAuditOptions {
    instanceName: InstanceName;
    filePath: string;
    eventBufferSize: number;
    limits?: Partial<AuditStorageLimits>;
    now?: () => number;
}

export type AuditEvents = Pick<AuditEventStore, "append" | "readFrom" | "readTail" | "readHighWater">;
export type AuditLogs = Pick<LogStoreInstance, "append" | "read">;
export type AuditToolCalls = Pick<AuditToolCallStore, "append" | "hasCall" | "readQuery" | "readFailureSummary">;

export class InstanceAudit {
    readonly events: AuditEvents;
    readonly logs: AuditLogs;
    readonly toolCalls: AuditToolCalls;
    readonly #eventStore: AuditEventStore;
    readonly #logStore: LogStoreInstance;
    readonly #toolCallStore: AuditToolCallStore;
    readonly #database: AuditDatabase;
    #closePromise?: Promise<void>;

    constructor(options: InstanceAuditOptions) {
        this.#database = new AuditDatabase(options.filePath, {
            ...resolveAuditStorageLimits(options.limits),
            now: options.now,
        });
        this.events = this.#eventStore = new AuditEventStore(this.#database, options.eventBufferSize);
        this.logs = this.#logStore = new LogStoreInstance(options.instanceName, this.#database.store<InstanceLogEntry>("logs", {
            sequence: (record) => record.seq,
            timestamp: (record) => record.at,
        }));
        this.toolCalls = this.#toolCallStore = new AuditToolCallStore(this.#database);
    }

    state<TValue>(namespace: string): StateStore<TValue> {
        this.#assertOpen();
        const store = this.#database.stateStore<TValue>(namespace);
        return {
            put: async (key, value) => {
                this.#assertOpen();
                await store.put(key, value);
            },
            delete: async (key) => {
                this.#assertOpen();
                await store.delete(key);
            },
            get: (key) => store.get(key),
            list: () => store.list(),
        };
    }

    close(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        this.#eventStore.close();
        this.#toolCallStore.close();
        this.#closePromise = this.#logStore.close().then(() => this.#database.close());
        return this.#closePromise;
    }
    #assertOpen(): void {
        if (this.#closePromise !== undefined) throw new Error("Instance audit is closing.");
    }
}

export function createInstanceAudit(options: InstanceAuditOptions): InstanceAudit {
    return new InstanceAudit(options);
}
