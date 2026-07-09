import { asInstanceName, type ControlEventEnvelope, type InstanceSnapshot, type JsonValue } from "@portable-devshell/shared";

import {
    createSubscribedStream,
    TuiControlConnection,
    type TuiControlConnectionOptions
} from "./TuiControlConnection.js";
import { createControlTarget, createInstanceTarget } from "./TuiControlRequest.js";
import type { TuiControlStream } from "./TuiControlStream.js";

export interface TuiControlSnapshotEnvelope {
    lastSeq: number;
    snapshot: InstanceSnapshot;
}

export interface TuiControlListInstanceEntry {
    mcpEnabled: boolean;
    name: string;
    snapshot?: InstanceSnapshot;
}

export interface TuiControlClientLike {
    getConfigView(): Promise<Record<string, JsonValue>>;
    getSnapshot(instance: string): Promise<TuiControlSnapshotEnvelope>;
    listInstances(): Promise<TuiControlListInstanceEntry[]>;
    ping(): Promise<{ pong: boolean }>;
    subscribe(instance: string, fromSeq: number): Promise<TuiControlStream>;
}

export class TuiControlClient implements TuiControlClientLike {
    readonly #connectionOptions: TuiControlConnectionOptions;

    constructor(options: TuiControlConnectionOptions = {}) {
        this.#connectionOptions = options;
    }

    async ping(): Promise<{ pong: boolean }> {
        return (await this.#request("control.ping", createControlTarget())) as unknown as { pong: boolean };
    }

    async listInstances(): Promise<TuiControlListInstanceEntry[]> {
        return (await this.#request("control.listInstances", createControlTarget())) as unknown as TuiControlListInstanceEntry[];
    }

    async getConfigView(): Promise<Record<string, JsonValue>> {
        return (await this.#request("control.getConfigView", createControlTarget())) as unknown as Record<string, JsonValue>;
    }

    async getSnapshot(instance: string): Promise<TuiControlSnapshotEnvelope> {
        return (await this.#request("instance.getSnapshot", createInstanceTarget(instance))) as unknown as TuiControlSnapshotEnvelope;
    }

    async subscribe(instance: string, fromSeq: number): Promise<TuiControlStream> {
        const connection = new TuiControlConnection(this.#connectionOptions);
        const result = (await connection.request("instance.subscribe", createInstanceTarget(instance), {
            fromSeq
        })) as unknown as {
            events: ControlEventEnvelope[] | JsonValue[];
            lastSeq: number;
        };

        return createSubscribedStream(connection, result.events.map((event) => normalizeInitialEvent(instance, event as JsonValue)));
    }

    async #request(method: string, target: ReturnType<typeof createControlTarget> | ReturnType<typeof createInstanceTarget>, params?: JsonValue): Promise<JsonValue> {
        const connection = new TuiControlConnection(this.#connectionOptions);

        try {
            return await connection.request(method, target, params);
        } finally {
            connection.close();
        }
    }
}

function normalizeInitialEvent(instance: string, value: JsonValue): ControlEventEnvelope {
    if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.type === "string" &&
        typeof value.seq === "number"
    ) {
        return {
            event: value.type,
            payload: value,
            seq: value.seq,
            target: {
                instance: asInstanceName(instance),
                kind: "instance"
            },
            type: "event"
        };
    }

    return {
        event: "stream.cancelled",
        payload: {
            instance,
            reason: "invalid.initialEvent"
        },
        seq: 0,
        target: {
            instance: asInstanceName(instance),
            kind: "instance"
        },
        type: "event"
    };
}
