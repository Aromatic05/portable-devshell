import {
    controlClientModule,
    type ClientConnection,
    type JsonValue
} from "@portable-devshell/shared";

export function createTuiClientService(connection: ClientConnection) {
    const service = controlClientModule(connection, "service");
    return {
        ping: (): Promise<{ pong: boolean }> => service.request("ping"),
        restart: (): Promise<Record<string, JsonValue>> => service.request("restart")
    };
}

export type TuiClientService = ReturnType<typeof createTuiClientService>;
