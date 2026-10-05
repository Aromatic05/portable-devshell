import { CONTROL_HOST } from "../../client/Control.js";
import { EventStreamReader } from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { MessageStream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../types/Json.js";
import type {
    ConfigUpdateInstanceRequest,
    ConfigView,
} from "../config/Model.js";
import type {
    InstanceChangeEvent,
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    InstanceListEnvelope,
} from "./Model.js";
import {
    type InstanceChangeStreamPort,
    readInstanceChangeEvent,
    readInstanceChangeStreamGapPayload,
} from "./Revision.js";

export interface InstanceTransport {
    acquireInstanceReference(
        instanceName: string,
        reference: string,
    ): Promise<Record<string, JsonValue>>;
    createInstance(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
    createInstanceSchema(): Promise<InstanceCreateSchema>;
    deleteInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    disableInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    enableInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    listInstances(): Promise<InstanceListEnvelope["instances"]>;
    releaseInstanceReference(instanceName: string, reference: string): Promise<void>;
    snapshotInstances(): Promise<InstanceListEnvelope>;
    subscribeInstances(fromRevision: number): Promise<InstanceChangeStreamPort>;
    updateInstance(request: ConfigUpdateInstanceRequest): Promise<ConfigView>;
    validateInstanceCreate(
        draft: InstanceCreateDraft,
    ): Promise<InstanceCreateSummary>;
}

export function createInstanceTransport(endpoint: Endpoint): InstanceTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "instance");
    return {
        acquireInstanceReference: (instanceName, reference) =>
            port.request<Record<string, JsonValue>>("acquireInstanceReference", {
                instanceName,
                reference,
            }),
        createInstance: (draft) =>
            port.request<InstanceCreateResult>("createInstance", draft),
        createInstanceSchema: () =>
            port.request<InstanceCreateSchema>("createInstanceSchema"),
        deleteInstance: (instanceName) =>
            port.request<Record<string, JsonValue>>("deleteInstance", {
                instanceName,
            }),
        disableInstance: (instanceName) =>
            port.request<Record<string, JsonValue>>("disableInstance", {
                instanceName,
            }),
        enableInstance: (instanceName) =>
            port.request<Record<string, JsonValue>>("enableInstance", {
                instanceName,
            }),
        listInstances: () =>
            port.request<InstanceListEnvelope["instances"]>("listInstances"),
        releaseInstanceReference: async (instanceName, reference) => {
            await port.request("releaseInstanceReference", { instanceName, reference });
        },
        snapshotInstances: () =>
            port.request<InstanceListEnvelope>("snapshotInstances"),
        subscribeInstances: async (fromRevision) =>
            new InstanceChangeStream(
                await port.open("subscribeInstances", { fromRevision }),
            ),
        updateInstance: (request) =>
            port.request<ConfigView>("updateInstance", request),
        validateInstanceCreate: (draft) =>
            port.request<InstanceCreateSummary>(
                "validateInstanceCreate",
                draft,
            ),
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
