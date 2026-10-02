import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import {
    EventStreamReader,
    readStreamGapPayload,
    type EventStreamPort,
} from "../../transport/stream/EventStream.js";
import type { JsonValue } from "../../transport/primitive/JsonValue.js";
import { CONTROL_HOST } from "../connection/Control.js";
import {
    configOperations,
    readConfigChangeEvent,
    readConfigSnapshot,
    type ConfigChangeEvent,
    type ConfigOperation,
    type ConfigRequest,
    type ConfigResponse,
    type ConfigSnapshot,
} from "./Contract.js";
import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
    ConfigView,
} from "./Edit.js";

export type ConfigChangeStreamPort = EventStreamPort<ConfigChangeEvent>;

export interface ConfigTransport {
    get(): Promise<ConfigView>;
    snapshot(): Promise<ConfigSnapshot>;
    update(request: ConfigBatchUpdateRequest): Promise<ConfigView>;
    updateInstance(request: ConfigUpdateInstanceRequest): Promise<ConfigView>;
    updateMcpEndpoint(request: ConfigUpdateMcpRequest): Promise<ConfigView>;
    updateWeb(request: ConfigUpdateWebRequest): Promise<ConfigView>;
    validate(draft: ConfigDraft): Promise<ConfigView>;
    subscribe(fromRevision: number): Promise<ConfigChangeStreamPort>;
}

export function createConfigTransport(endpoint: Endpoint): ConfigTransport {
    return configTransport(createPortClient(endpoint, CONTROL_HOST, "config"));
}

export function configTransport(port: PortClient): ConfigTransport {
    const request = <Operation extends ConfigOperation>(
        operation: Operation,
        payload: ConfigRequest<Operation>,
    ): Promise<ConfigResponse<Operation>> =>
        port.request<ConfigResponse<Operation>>(operation, payload);
    return {
        get: () => request(configOperations.get, undefined),
        snapshot: async () =>
            readConfigSnapshot(
                await port.request<JsonValue>(
                    configOperations.snapshot,
                    undefined,
                ),
            ),
        subscribe: async (fromRevision) =>
            new EventStreamReader<ConfigChangeEvent>(
                await port.open(configOperations.subscribe, { fromRevision }),
                {
                    decodeEvent: readConfigChangeEvent,
                    readGap: readStreamGapPayload,
                },
            ),
        update: (draft) => request(configOperations.update, draft),
        updateInstance: (draft) =>
            request(configOperations.updateInstance, draft),
        updateMcpEndpoint: (draft) =>
            request(configOperations.updateMcpEndpoint, draft),
        updateWeb: (draft) => request(configOperations.updateWeb, draft),
        validate: (draft) => request(configOperations.validate, draft),
    };
}
