// Configuration wire contract for the Control config port. The transport in
// ./Transport.ts is typed against this map, so an operation cannot be called
// with a mismatched request or response shape.

import type {
    ConfigBatchUpdateRequest,
    ConfigDraft,
    ConfigUpdateInstanceRequest,
    ConfigUpdateMcpRequest,
    ConfigUpdateWebRequest,
    ConfigView,
} from "./Edit.js";

export const configOperations = {
    get: "get",
    update: "update",
    updateInstance: "updateInstance",
    updateMcpEndpoint: "updateMcpEndpoint",
    updateWeb: "updateWeb",
    validate: "validate",
} as const;

export interface ConfigContract {
    get: {
        request: undefined;
        response: ConfigView;
    };
    update: {
        request: ConfigBatchUpdateRequest;
        response: ConfigView;
    };
    updateInstance: {
        request: ConfigUpdateInstanceRequest;
        response: ConfigView;
    };
    updateMcpEndpoint: {
        request: ConfigUpdateMcpRequest;
        response: ConfigView;
    };
    updateWeb: {
        request: ConfigUpdateWebRequest;
        response: ConfigView;
    };
    validate: {
        request: ConfigDraft;
        response: ConfigView;
    };
}

export type ConfigOperation = keyof ConfigContract;

export type ConfigRequest<Operation extends ConfigOperation> =
    ConfigContract[Operation]["request"];

export type ConfigResponse<Operation extends ConfigOperation> =
    ConfigContract[Operation]["response"];