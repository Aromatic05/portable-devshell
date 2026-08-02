import {
    controlClientModule,
    type ClientConnection,
    type ConfigBatchUpdateRequest,
    type ConfigDraft,
    type ConfigUpdateInstanceRequest,
    type ConfigUpdateMcpRequest,
    type ConfigUpdateWebRequest,
    type JsonValue
} from "@portable-devshell/shared";

export function createTuiClientConfig(connection: ClientConnection) {
    const config = controlClientModule(connection, "config");
    return {
        get: (): Promise<Record<string, JsonValue>> => config.request("get"),
        validate: (draft: ConfigDraft): Promise<Record<string, JsonValue>> => config.request("validate", draft),
        update: (request: ConfigBatchUpdateRequest): Promise<JsonValue> => config.request("update", request),
        updateInstance: (request: ConfigUpdateInstanceRequest): Promise<Record<string, JsonValue>> =>
            config.request("updateInstance", request),
        updateMcpEndpoint: (request: ConfigUpdateMcpRequest): Promise<Record<string, JsonValue>> =>
            config.request("updateMcpEndpoint", request),
        updateWeb: (request: ConfigUpdateWebRequest): Promise<Record<string, JsonValue>> => config.request("updateWeb", request)
    };
}

export type TuiClientConfig = ReturnType<typeof createTuiClientConfig>;
