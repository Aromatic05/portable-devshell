import { errorCodes, type InstanceEvent, type InstanceName, type JsonValue } from "@portable-devshell/shared";

import { JsonlStore } from "../store/JsonlStore.js";

export interface InstanceEventInput {
    at: string;
    data?: JsonValue;
    type: InstanceEvent["type"];
}

export interface EventStreamGap {
    code: typeof errorCodes.streamGap;
    fromSeq: number;
    kind: "gap";
    lastSeq: number;
    nextSeq: number;
}

export interface EventStreamSlice {
    events: InstanceEvent[];
    kind: "events";
    lastSeq: number;
}

export class InstanceEventBuffer {
    readonly #instanceName: InstanceName;
    readonly #capacity: number;
    readonly #store?: JsonlStore<InstanceEvent>;
    #initialized = false;
    #events: InstanceEvent[] = [];
    #lastSeq = 0;

    constructor(instanceName: InstanceName, capacity: number, store?: JsonlStore<InstanceEvent>) {
        this.#instanceName = instanceName;
        this.#capacity = capacity;
        this.#store = store;
    }

    get lastSeq(): number {
        return this.#lastSeq;
    }

    async append(event: InstanceEventInput): Promise<InstanceEvent> {
        await this.#initialize();

        const storedEvent: InstanceEvent = {
            at: event.at,
            data: event.data,
            instanceName: this.#instanceName,
            seq: this.#lastSeq + 1,
            type: event.type
        };

        this.#lastSeq = storedEvent.seq;
        this.#events.push(storedEvent);

        if (this.#events.length > this.#capacity) {
            this.#events.shift();
        }

        await this.#store?.append(storedEvent);
        return storedEvent;
    }

    readFrom(fromSeq = 1): EventStreamGap | EventStreamSlice {
        const nextSeq = this.#events[0]?.seq ?? this.#lastSeq + 1;

        if (fromSeq < nextSeq) {
            return {
                code: errorCodes.streamGap,
                fromSeq,
                kind: "gap",
                lastSeq: this.#lastSeq,
                nextSeq
            };
        }

        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events",
            lastSeq: this.#lastSeq
        };
    }

    async #initialize(): Promise<void> {
        if (this.#initialized || this.#store === undefined) {
            this.#initialized = true;
            return;
        }

        const records = await this.#store.readAll();
        this.#events = records.slice(-this.#capacity);
        this.#lastSeq = records.at(-1)?.seq ?? 0;
        this.#initialized = true;
    }
}
