import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import { CONTROL_HOST } from "../connection/Control.js";
import {
    configOperations,
    type ConfigOperation,
    type ConfigRequest,
    type ConfigResponse,
} from "./Contract.js";
import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
    ConfigView,
} from "./Edit.js";

export interface ConfigTransport {
    get(): Promise<ConfigView>;
    update(request: ConfigBatchUpdateRequest): Promise<ConfigView>;
    updateInstance(request: ConfigUpdateInstanceRequest): Promise<ConfigView>;
    updateMcpEndpoint(request: ConfigUpdateMcpRequest): Promise<ConfigView>;
    updateWeb(request: ConfigUpdateWebRequest): Promise<ConfigView>;
    validate(draft: ConfigDraft): Promise<ConfigView>;
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
        update: (draft) => request(configOperations.update, draft),
        updateInstance: (draft) =>
            request(configOperations.updateInstance, draft),
        updateMcpEndpoint: (draft) =>
            request(configOperations.updateMcpEndpoint, draft),
        updateWeb: (draft) => request(configOperations.updateWeb, draft),
        validate: (draft) => request(configOperations.validate, draft),
    };
}