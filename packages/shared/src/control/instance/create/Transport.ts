// Thin typed instance-management transport on the Control instance port.
// Lifecycle calls open one RPC per operation; `subscribe` owns its message
// stream for the lifetime of the change subscription.

import type { Endpoint } from "../../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../../transport/packet/Rpc.js";
import {
    Stream,
    type MessageStream,
} from "../../../transport/packet/Stream.js";
import { EventStreamReader } from "../../../transport/stream/EventStream.js";
import type { JsonValue } from "../../../transport/primitive/JsonValue.js";
import {
    instanceOperations,
    readInstanceChangeEvent,
    readInstanceChangeStreamGapPayload,
    type InstanceChangeStreamPort,
    type InstanceOperation,
    type InstanceRequest,
    type InstanceResponse,
} from "./Contract.js";
import type {
    InstanceChangeEvent,
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    InstanceListEnvelope,
} from "./Model.js";

export const INSTANCE_HOST = "@control";
export const INSTANCE_PORT = "instance";

export interface InstanceManagementTransport {
    create(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
    createSchema(): Promise<InstanceCreateSchema>;
    delete(instanceName: string): Promise<Record<string, JsonValue>>;
    disable(instanceName: string): Promise<Record<string, JsonValue>>;
    enable(instanceName: string): Promise<Record<string, JsonValue>>;
    list(): Promise<InstanceListEnvelope["instances"]>;
    snapshot(): Promise<InstanceListEnvelope>;
    subscribe(fromRevision: number): Promise<InstanceChangeStreamPort>;
    validateCreate(draft: InstanceCreateDraft): Promise<InstanceCreateSummary>;
}

export function createInstanceManagementTransport(
    endpoint: Endpoint,
): InstanceManagementTransport {
    const request = async <Operation extends InstanceOperation>(
        operation: Operation,
        payload: InstanceRequest<Operation>,
    ): Promise<InstanceResponse<Operation>> => {
        const rpc = new Rpc(
            await endpoint.connect(INSTANCE_HOST, INSTANCE_PORT),
        );
        try {
            return await rpc.request<InstanceResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    const open = async (
        operation: string,
        payload?: JsonValue,
    ): Promise<MessageStream> => {
        const protocol = new Stream(
            await endpoint.connect(INSTANCE_HOST, INSTANCE_PORT),
        );
        const stream = await protocol.open(operation, payload);
        const close = () => protocol.close();
        stream.onClose(close);
        stream.onCancel(close);
        return stream;
    };
    return {
        create: (draft) => request(instanceOperations.create, draft),
        createSchema: () => request(instanceOperations.createSchema, undefined),
        delete: (instanceName) =>
            request(instanceOperations.delete, { instanceName }),
        disable: (instanceName) =>
            request(instanceOperations.disable, { instanceName }),
        enable: (instanceName) =>
            request(instanceOperations.enable, { instanceName }),
        list: () => request(instanceOperations.list, undefined),
        snapshot: () => request(instanceOperations.snapshot, undefined),
        subscribe: async (fromRevision) =>
            new InstanceChangeStream(
                await open(instanceOperations.subscribe, { fromRevision }),
            ),
        validateCreate: (draft) =>
            request(instanceOperations.validateCreate, draft),
    };
}

class InstanceChangeStream extends EventStreamReader<InstanceChangeEvent> {
    constructor(stream: MessageStream) {
        super(stream, {
            decodeEvent: readInstanceChangeEvent,
            readGap: readInstanceChangeStreamGapPayload,
        });
    }
}
