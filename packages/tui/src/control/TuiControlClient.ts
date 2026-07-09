import type {
    ApprovalRequest,
    ControlEventEnvelope,
    InstanceSnapshot,
    JsonValue,
    ToolCallQuery,
    ToolCallRecord
} from "@portable-devshell/shared";
import { asInstanceName } from "@portable-devshell/shared";
import {
    createSubscribedStream,
    TuiControlConnection,
    type TuiControlConnectionOptions
} from "./TuiControlConnection.js";
import {
    createControlTarget,
    createInstanceTarget,
    type TuiControlEventEnvelope
} from "./TuiControlRequest.js";
import type { TuiControlStream } from "./TuiControlStream.js";

export interface TuiControlSnapshotEnvelope {
    lastSeq: number;
    snapshot: InstanceSnapshot;
}

export interface TuiControlListInstanceEntry {
    mcpEnabled: boolean;
    name: string;
    snapshot: TuiControlSnapshotEnvelope["snapshot"];
}

export interface TuiControlClientLike {
    getConfigView(): Promise<Record<string, JsonValue>>;
    getSnapshot(instance: string): Promise<TuiControlSnapshotEnvelope>;
    listApprovals(instance: string): Promise<ApprovalRequest[]>;
    listInstances(): Promise<TuiControlListInstanceEntry[]>;
    readToolCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    subscribe(instance: string, fromSeq: number): Promise<TuiControlStream>;
}

export class TuiControlClient implements TuiControlClientLike {
    readonly #connectionOptions: TuiControlConnectionOptions;

    constructor(options: TuiControlConnectionOptions = {}) {
        this.#connectionOptions = options;
    }

    async listInstances(): Promise<TuiControlListInstanceEntry[]> {
        return (await this.#request("control.listInstances", createControlTarget())) as unknown as TuiControlListInstanceEntry[];
    }

    async getSnapshot(instance: string): Promise<TuiControlSnapshotEnvelope> {
        return (await this.#request("instance.getSnapshot", createInstanceTarget(instance))) as unknown as TuiControlSnapshotEnvelope;
    }

    async readToolCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]> {
        return (await this.#request("instance.readToolCalls", createInstanceTarget(instance), query as JsonValue | undefined)) as unknown as ToolCallRecord[];
    }

    async listApprovals(instance: string): Promise<ApprovalRequest[]> {
        return (await this.#request("instance.listApprovals", createInstanceTarget(instance))) as unknown as ApprovalRequest[];
    }

    async getConfigView(): Promise<Record<string, JsonValue>> {
        return (await this.#request("control.getConfigView", createControlTarget())) as unknown as Record<string, JsonValue>;
    }

    async subscribe(instance: string, fromSeq: number): Promise<TuiControlStream> {
        const connection = new TuiControlConnection(this.#connectionOptions);
        const result = (await connection.request("instance.subscribe", createInstanceTarget(instance), { fromSeq })) as unknown as {
            events: ControlEventEnvelope[] | JsonValue[];
            lastSeq: number;
        };

        return createSubscribedStream(connection, result.events.map((event) => normalizeInitialEvent(instance, event as JsonValue)));
    }

    async #request(
        method: string,
        target: ReturnType<typeof createControlTarget> | ReturnType<typeof createInstanceTarget>,
        params?: JsonValue
    ): Promise<JsonValue> {
        const connection = new TuiControlConnection(this.#connectionOptions);

        try {
            return await connection.request(method, target, params);
        } finally {
            connection.close();
        }
    }
}

function normalizeInitialEvent(instance: string, value: JsonValue): TuiControlEventEnvelope {
    if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.type === "string" &&
        typeof value.seq === "number"
    ) {
        return {
            event: value.type,
            payload: value as JsonValue,
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
