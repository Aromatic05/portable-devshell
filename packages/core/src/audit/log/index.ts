import type { InstanceName } from "@portable-devshell/shared";

import type { AuditSequenceStore } from "../RecordStore.js";
import type { InstanceLogEntry, LogQuery } from "../Api.js";


export class LogStoreInstance {
    readonly #instanceName: InstanceName;
    readonly #store: AuditSequenceStore<InstanceLogEntry>;
    #appendTail: Promise<void> = Promise.resolve();
    #initialized = false;
    #closing = false;
    #lastSeq = 0;

    constructor(
        instanceName: InstanceName,
        store: AuditSequenceStore<InstanceLogEntry>,
    ) {
        this.#instanceName = instanceName;
        this.#store = store;
    }

    async append(
        stream: InstanceLogEntry["stream"],
        message: string,
        at: string,
        context: Pick<
            InstanceLogEntry,
            "callId" | "requestId" | "ctxId" | "source" | "toolName"
        > = {},
    ): Promise<InstanceLogEntry> {
        if (this.#closing) throw new Error("Audit log store is closing.");
        const operation = this.#appendTail.then(async () => {
            this.#initialize();
            const entry: InstanceLogEntry = {
                at,
                ...(context.callId === undefined
                    ? {}
                    : { callId: context.callId }),
                ...(context.requestId === undefined
                    ? {}
                    : { requestId: context.requestId }),
                ...(context.ctxId === undefined
                    ? {}
                    : { ctxId: context.ctxId }),
                ...(context.source === undefined
                    ? {}
                    : { source: context.source }),
                ...(context.toolName === undefined
                    ? {}
                    : { toolName: context.toolName }),
                instanceName: this.#instanceName,
                message,
                seq: this.#lastSeq + 1,
                stream,
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
        const records = query.fromSeq === undefined && query.limit !== undefined
            ? this.#store.readTail(query.limit, query.maxDecodedBytes)
            : this.#store.readFromSeq(query.fromSeq ?? 1, query.limit, query.maxDecodedBytes);
        return applyDecodedByteBudget(records, query.maxDecodedBytes, query.fromSeq === undefined);
    }

    async close(): Promise<void> {
        this.#closing = true;
        await this.#appendTail;
    }

    #initialize(): void {
        if (this.#initialized) {
            return;
        }

        const records = this.#store.readTail(1);
        this.#lastSeq = Math.max(
            records.at(-1)?.seq ?? 0,
            this.#store.readHighWater(),
        );
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
