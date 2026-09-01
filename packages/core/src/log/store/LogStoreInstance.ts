import type { InstanceName } from "@portable-devshell/shared";

import type { AuditRecordStore } from "../../audit/AuditRecordStore.js";
import type { LogQuery } from "../LogQuery.js";

export interface InstanceLogEntry {
    at: string;
    callId?: string;
    instanceName: InstanceName;
    message: string;
    requestId?: string;
    seq: number;
    ctxId?: string;
    source?: "cli" | "mcp" | "tui" | "web";
    stream: "stderr" | "stdout";
    toolName?: string;
}

export class LogStoreInstance {
    readonly #instanceName: InstanceName;
    readonly #store: AuditRecordStore<InstanceLogEntry>;
    #initialized = false;
    #lastSeq = 0;

    constructor(instanceName: InstanceName, store: AuditRecordStore<InstanceLogEntry>) {
        this.#instanceName = instanceName;
        this.#store = store;
    }

    async append(
        stream: InstanceLogEntry["stream"],
        message: string,
        at: string,
        context: Pick<InstanceLogEntry, "callId" | "requestId" | "ctxId" | "source" | "toolName"> = {}
    ): Promise<InstanceLogEntry> {
        await this.#initialize();

        const entry: InstanceLogEntry = {
            at,
            ...context,
            instanceName: this.#instanceName,
            message,
            seq: this.#lastSeq + 1,
            stream
        };

        this.#lastSeq = entry.seq;
        await this.#store.append(entry);
        return entry;
    }

    async read(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        const fromSeq = query.fromSeq ?? 1;
        if (this.#store.readFromSeq !== undefined) {
            return await this.#store.readFromSeq(fromSeq, query.limit, query.maxDecodedBytes);
        }
        const records = await this.#store.readAll();
        const filtered = records.filter((record) => record.seq >= fromSeq);

        if (query.limit === undefined) {
            return filtered;
        }

        return filtered.slice(0, query.limit);
    }

    async #initialize(): Promise<void> {
        if (this.#initialized) {
            return;
        }

        const records = this.#store.readTail === undefined
            ? await this.#store.readAll()
            : await this.#store.readTail(1);
        this.#lastSeq = Math.max(records.at(-1)?.seq ?? 0, await this.#store.readHighWater?.() ?? 0);
        this.#initialized = true;
    }
}
