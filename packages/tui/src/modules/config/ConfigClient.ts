import {
    controlClientModule,
    type ClientConnection,
    type ConfigDraft,
    type ConfigUpdateInstanceRequest,
    type ConfigUpdateMcpRequest,
    type JsonValue
} from "@portable-devshell/shared";

export function createConfigClient(connection: ClientConnection) {
    const config = controlClientModule(connection, "config");
    return {
        get: (): Promise<Record<string, JsonValue>> => config.request("get"),
        validate: (draft: ConfigDraft): Promise<Record<string, JsonValue>> => config.request("validate", draft),
        updateInstance: (request: ConfigUpdateInstanceRequest): Promise<Record<string, JsonValue>> =>
            config.request("updateInstance", request),
        updateMcp: (request: ConfigUpdateMcpRequest): Promise<Record<string, JsonValue>> =>
            config.request("updateMcp", request),
        apply: (): Promise<JsonValue> => config.request("apply")
    };
}

export type ConfigClient = ReturnType<typeof createConfigClient>;
