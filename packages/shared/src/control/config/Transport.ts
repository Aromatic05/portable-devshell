import { CONTROL_HOST } from "../../client/Control.js";
import {
    type EventStreamPort,
    EventStreamReader,
    readStreamGapPayload,
} from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type { JsonValue } from "../../types/Json.js";
import {
    type ConfigChangeEvent,
    type ConfigSnapshot,
    readConfigChangeEvent,
    readConfigSnapshot,
} from "./Revision.js";
import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
    ConfigView,
} from "./Model.js";
export interface ConfigTransport {
    get(): Promise<ConfigView>;
    snapshot(): Promise<ConfigSnapshot>;
    subscribe(fromRevision: number): Promise<EventStreamPort<ConfigChangeEvent>>;
    update(request: ConfigBatchUpdateRequest): Promise<ConfigView>;
    updateMcpEndpoint(request: ConfigUpdateMcpRequest): Promise<ConfigView>;
    updateWeb(request: ConfigUpdateWebRequest): Promise<ConfigView>;
    validate(draft: ConfigDraft): Promise<ConfigView>;
}

export function createConfigTransport(endpoint: Endpoint): ConfigTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "config");
    return {
        get: () => port.request<ConfigView>("get"),
        snapshot: async () =>
            readConfigSnapshot(await port.request<JsonValue>("snapshot")),
        subscribe: async (fromRevision) =>
            new EventStreamReader<ConfigChangeEvent>(
                await port.open("subscribe", { fromRevision }),
                {
                    decodeEvent: readConfigChangeEvent,
                    readGap: readStreamGapPayload,
                },
            ),
        update: (request) => port.request<ConfigView>("update", request),
        updateMcpEndpoint: (request) =>
            port.request<ConfigView>("updateMcpEndpoint", request),
        updateWeb: (request) => port.request<ConfigView>("updateWeb", request),
        validate: (draft) => port.request<ConfigView>("validate", draft),
    };
}
