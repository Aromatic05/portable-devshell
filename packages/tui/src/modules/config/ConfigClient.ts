import {
    controlClientModule,
    type ClientConnection,
    type JsonValue
} from "@portable-devshell/shared";

export function createConfigClient(connection: ClientConnection) {
    const config = controlClientModule(connection, "config");
    return {
        get: (): Promise<Record<string, JsonValue>> => config.request("get"),
        validate: (draft: JsonValue): Promise<Record<string, JsonValue>> => config.request("validate", draft),
        updateInstance: (value: JsonValue): Promise<Record<string, JsonValue>> =>
            config.request("updateInstance", value),
        updateMcp: (value: JsonValue): Promise<Record<string, JsonValue>> => config.request("updateMcp", value),
        apply: (): Promise<JsonValue> => config.request("apply")
    };
}

export type ConfigClient = ReturnType<typeof createConfigClient>;
