import type { InstanceName } from "../../../../shared/dist/types/InstanceName.js";

import type { LogQuery } from "../query/LogQuery.js";
import { JsonlStore } from "./JsonlStore.js";

export interface InstanceLogEntry {
    at: string;
    instanceName: InstanceName;
    message: string;
    seq: number;
    stream: "stderr" | "stdout";
}

export class InstanceLogStore {
    readonly #instanceName: InstanceName;
    readonly #store: JsonlStore<InstanceLogEntry>;
    #initialized = false;
    #lastSeq = 0;

    constructor(instanceName: InstanceName, store: JsonlStore<InstanceLogEntry>) {
        this.#instanceName = instanceName;
        this.#store = store;
    }

    async append(stream: InstanceLogEntry["stream"], message: string, at: string): Promise<InstanceLogEntry> {
        await this.#initialize();

        const entry: InstanceLogEntry = {
            at,
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
        const records = await this.#store.readAll();
        const fromSeq = query.fromSeq ?? 1;
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

        const records = await this.#store.readAll();
        this.#lastSeq = records.at(-1)?.seq ?? 0;
        this.#initialized = true;
    }
}
