import {
    EventStreamReader,
    readStreamGapPayload,
    type EventStreamPort,
    type InstanceEventRecord,
    type InstanceEventStreamGap,
    type InstanceEventStreamSlice,
} from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type { JsonValue } from "../../types/Json.js";

export const INSTANCE_RUNTIME_PORT = "instance";

export interface InstanceRuntimeTransport {
    acquireReference(reference: string): Promise<Record<string, JsonValue>>;
    appendEvent(type: string, data?: JsonValue): Promise<void>;
    readEvents(
        fromSeq: number,
    ): Promise<InstanceEventStreamGap | InstanceEventStreamSlice>;
    releaseReference(reference: string): Promise<void>;
    subscribeEvents(
        fromSeq: number,
    ): Promise<EventStreamPort<InstanceEventRecord>>;
}

export function createInstanceRuntimeTransport(
    endpoint: Endpoint,
    instance: string,
): InstanceRuntimeTransport {
    const port = createPortClient(
        endpoint,
        asInstanceName(instance),
        INSTANCE_RUNTIME_PORT,
    );
    return {
        acquireReference: (reference) =>
            port.request<Record<string, JsonValue>>("acquireReference", {
                reference,
            }),
        appendEvent: async (type, data) => {
            await port.request("appendEvent", {
                ...(data === undefined ? {} : { data }),
                type,
            });
        },
        readEvents: (fromSeq) =>
            port.request<InstanceEventStreamGap | InstanceEventStreamSlice>(
                "readEvents",
                { fromSeq },
            ),
        releaseReference: async (reference) => {
            await port.request("releaseReference", { reference });
        },
        subscribeEvents: async (fromSeq) =>
            new EventStreamReader<InstanceEventRecord>(
                await port.open("subscribeEvents", { fromSeq }),
                {
                    decodeEvent: readInstanceEvent,
                    readGap: readStreamGapPayload,
                },
            ),
    };
}

function readInstanceEvent(value: JsonValue | undefined): InstanceEventRecord {
    const record =
        typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : undefined;
    if (
        record === undefined ||
        typeof record.at !== "string" ||
        typeof record.instanceName !== "string" ||
        typeof record.seq !== "number" ||
        typeof record.type !== "string"
    )
        throw new Error("Invalid Instance event record.");
    return {
        at: record.at,
        ...(record.data === undefined ? {} : { data: record.data }),
        instanceName: asInstanceName(record.instanceName),
        seq: record.seq,
        type: record.type,
    };
}
