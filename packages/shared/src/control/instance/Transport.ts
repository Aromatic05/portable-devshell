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
    createInstance(draft: InstanceCreateDraft, signal?: AbortSignal): Promise<InstanceCreateResult>;
    createInstanceSchema(): Promise<InstanceCreateSchema>;
    deleteInstance(instanceName: string, signal?: AbortSignal): Promise<Record<string, JsonValue>>;
    disableInstance(instanceName: string, signal?: AbortSignal): Promise<Record<string, JsonValue>>;
    enableInstance(instanceName: string, signal?: AbortSignal): Promise<Record<string, JsonValue>>;
    listInstances(): Promise<InstanceListEnvelope["instances"]>;
    listCleanupDebts(): Promise<Array<Record<string, string>>>;
    retryCleanupDebt(instanceName: string): Promise<Array<Record<string, string>>>;
    snapshotInstances(signal?: AbortSignal): Promise<InstanceListEnvelope>;
    subscribeInstances(fromRevision: number): Promise<InstanceChangeStreamPort>;
    updateInstance(request: ConfigUpdateInstanceRequest): Promise<ConfigView>;
    validateInstanceCreate(
        draft: InstanceCreateDraft,
    ): Promise<InstanceCreateSummary>;
}

export function createInstanceTransport(endpoint: Endpoint): InstanceTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "instance");
    return {
        createInstance: (draft, signal) =>
            port.request<InstanceCreateResult>("createInstance", draft, signal),
        createInstanceSchema: () =>
            port.request<InstanceCreateSchema>("createInstanceSchema"),
        deleteInstance: (instanceName, signal) =>
            port.request<Record<string, JsonValue>>("deleteInstance", {
                instanceName,
            }, signal),
        disableInstance: (instanceName, signal) =>
            port.request<Record<string, JsonValue>>("disableInstance", {
                instanceName,
            }, signal),
        enableInstance: (instanceName, signal) =>
            port.request<Record<string, JsonValue>>("enableInstance", {
                instanceName,
            }, signal),
        listCleanupDebts: () =>
            port.request<Array<Record<string, string>>>("listCleanupDebts"),
        retryCleanupDebt: (instanceName) =>
            port.request<Array<Record<string, string>>>("retryCleanupDebt", { instanceName }),
        listInstances: () =>
            port.request<InstanceListEnvelope["instances"]>("listInstances"),
        snapshotInstances: (signal) =>
            port.request<InstanceListEnvelope>("snapshotInstances", undefined, signal),
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
