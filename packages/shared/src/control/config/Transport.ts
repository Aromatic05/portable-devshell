import { CONTROL_HOST } from "../../client/Control.js";
import {
    type EventStreamPort,
    EventStreamReader,
    readStreamGapPayload,
} from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { MessageStream } from "../../transport/packet/Stream.js";
import type { JsonValue } from "../../types/Json.js";
import {
    type ConfigChangeEvent,
    type ConfigSnapshot,
    type InstanceChangeStreamPort,
    readConfigChangeEvent,
    readConfigSnapshot,
    readInstanceChangeEvent,
    readInstanceChangeStreamGapPayload,
} from "./Revision.js";
import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
    ConfigView,
    InstanceChangeEvent,
    InstanceCreateDraft,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    InstanceListEnvelope,
} from "./Model.js";
import type {
    ConversationPreferencesPatch,
    ConversationPreferencesSnapshot,
} from "./Preference.js";

export interface ConfigTransport {
    createInstance(draft: InstanceCreateDraft): Promise<InstanceCreateResult>;
    createInstanceSchema(): Promise<InstanceCreateSchema>;
    deleteInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    disableInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    enableInstance(instanceName: string): Promise<Record<string, JsonValue>>;
    get(): Promise<ConfigView>;
    getConversationPreferences(): Promise<ConversationPreferencesSnapshot>;
    listInstances(): Promise<InstanceListEnvelope["instances"]>;
    snapshot(): Promise<ConfigSnapshot>;
    snapshotInstances(): Promise<InstanceListEnvelope>;
    subscribe(fromRevision: number): Promise<EventStreamPort<ConfigChangeEvent>>;
    subscribeInstances(fromRevision: number): Promise<InstanceChangeStreamPort>;
    update(request: ConfigBatchUpdateRequest): Promise<ConfigView>;
    updateConversationPreferences(
        patch: ConversationPreferencesPatch,
    ): Promise<ConversationPreferencesSnapshot>;
    updateInstance(request: ConfigUpdateInstanceRequest): Promise<ConfigView>;
    updateMcpEndpoint(request: ConfigUpdateMcpRequest): Promise<ConfigView>;
    updateWeb(request: ConfigUpdateWebRequest): Promise<ConfigView>;
    validate(draft: ConfigDraft): Promise<ConfigView>;
    validateInstanceCreate(
        draft: InstanceCreateDraft,
    ): Promise<InstanceCreateSummary>;
}

export function createConfigTransport(endpoint: Endpoint): ConfigTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "config");
    return {
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
        get: () => port.request<ConfigView>("get"),
        getConversationPreferences: () =>
            port.request<ConversationPreferencesSnapshot>(
                "getConversationPreferences",
            ),
        listInstances: () =>
            port.request<InstanceListEnvelope["instances"]>("listInstances"),
        snapshot: async () =>
            readConfigSnapshot(await port.request<JsonValue>("snapshot")),
        snapshotInstances: () =>
            port.request<InstanceListEnvelope>("snapshotInstances"),
        subscribe: async (fromRevision) =>
            new EventStreamReader<ConfigChangeEvent>(
                await port.open("subscribe", { fromRevision }),
                {
                    decodeEvent: readConfigChangeEvent,
                    readGap: readStreamGapPayload,
                },
            ),
        subscribeInstances: async (fromRevision) =>
            new InstanceChangeStream(
                await port.open("subscribeInstances", { fromRevision }),
            ),
        update: (request) => port.request<ConfigView>("update", request),
        updateConversationPreferences: (patch) =>
            port.request<ConversationPreferencesSnapshot>(
                "updateConversationPreferences",
                patch,
            ),
        updateInstance: (request) =>
            port.request<ConfigView>("updateInstance", request),
        updateMcpEndpoint: (request) =>
            port.request<ConfigView>("updateMcpEndpoint", request),
        updateWeb: (request) => port.request<ConfigView>("updateWeb", request),
        validate: (draft) => port.request<ConfigView>("validate", draft),
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
