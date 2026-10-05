import type { AuditRuntime } from "./Api.js";
import type { AuditRuntimeOptions } from "./Api.js";

import type { AuditApi, InstanceLogEntry, StateStore } from "./Api.js";
import { AuditDatabase } from "./database/index.js";
import { resolveAuditStorageLimits } from "./database/Limits.js";

import { AuditEventStore } from "./event/index.js";
import { LogStoreInstance } from "./log/index.js";
import { AuditToolCallStore } from "./toolcall/index.js";



class AuditRuntimeInstance implements AuditRuntime {
    readonly api: AuditApi;
    readonly #eventStore: AuditEventStore;
    readonly #logStore: LogStoreInstance;
    readonly #toolCallStore: AuditToolCallStore;
    readonly #database: AuditDatabase;
    #closePromise?: Promise<void>;

    constructor(options: AuditRuntimeOptions) {
        this.#database = new AuditDatabase(options.filePath, {
            ...resolveAuditStorageLimits(options.limits),
            now: options.now,
        });
        this.#eventStore = new AuditEventStore(
            this.#database,
            options.eventBufferSize,
        );
        this.#logStore = new LogStoreInstance(
            options.instanceName,
            this.#database.store<InstanceLogEntry>("logs", {
                sequence: (record) => record.seq,
                timestamp: (record) => record.at,
            }),
        );
        this.#toolCallStore = new AuditToolCallStore(this.#database);
        this.api = {
            events: this.#eventStore,
            logs: this.#logStore,
            toolCalls: this.#toolCallStore,
            state: <TValue>(namespace: string) =>
                this.#state<TValue>(namespace),
        };
    }

    close(): Promise<void> {
        if (this.#closePromise !== undefined) return this.#closePromise;
        this.#eventStore.close();
        this.#toolCallStore.close();
        this.#closePromise = (async () => {
            const failures: unknown[] = [];
            try {
                await this.#logStore.close();
            } catch (error) {
                failures.push(error);
            }
            try {
                await this.#database.close();
            } catch (error) {
                failures.push(error);
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1)
                throw new AggregateError(failures, "Audit runtime failed to close.");
        })();
        return this.#closePromise;
    }

    #state<TValue>(namespace: string): StateStore<TValue> {
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

    #assertOpen(): void {
        if (this.#closePromise !== undefined) throw new Error("Instance audit is closing.");
    }
}

export function createAuditRuntime(options: AuditRuntimeOptions): AuditRuntime {
    return new AuditRuntimeInstance(options);
}
