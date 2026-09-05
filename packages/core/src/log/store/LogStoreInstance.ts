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
    #appendTail: Promise<void> = Promise.resolve();
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
        const operation = this.#appendTail.then(async () => {
            await this.#initialize();
            const entry: InstanceLogEntry = {
                at,
                ...context,
                instanceName: this.#instanceName,
                message,
                seq: this.#lastSeq + 1,
                stream
            };
            await this.#store.append(entry);
            this.#lastSeq = entry.seq;
            return entry;
        });
        this.#appendTail = operation.then(
            () => undefined,
            () => undefined,
        );
        return await operation;
    }

    async read(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        if (query.fromSeq === undefined && query.limit !== undefined && this.#store.readTail !== undefined) {
            return await this.#store.readTail(query.limit, query.maxDecodedBytes);
        }
        const fromSeq = query.fromSeq ?? 1;
        if (this.#store.readFromSeq !== undefined) {
            return await this.#store.readFromSeq(fromSeq, query.limit, query.maxDecodedBytes);
        }
        const records = await this.#store.readAll();
        const filtered = records.filter((record) => record.seq >= fromSeq);

        const limited = query.limit === undefined
            ? filtered
            : query.fromSeq === undefined
                ? filtered.slice(-query.limit)
                : filtered.slice(0, query.limit);
        return applyDecodedByteBudget(limited, query.maxDecodedBytes, query.fromSeq === undefined);
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

function applyDecodedByteBudget(
    records: InstanceLogEntry[],
    maxDecodedBytes: number | undefined,
    newestFirst: boolean,
): InstanceLogEntry[] {
    if (maxDecodedBytes === undefined) return records;
    const candidates = newestFirst ? [...records].reverse() : records;
    const accepted: InstanceLogEntry[] = [];
    let decodedBytes = 0;
    for (const record of candidates) {
        if (newestFirst) accepted.unshift(record);
        else accepted.push(record);
        decodedBytes += Buffer.byteLength(record.message, "utf8");
        if (decodedBytes >= maxDecodedBytes) break;
    }
    return accepted;
}
