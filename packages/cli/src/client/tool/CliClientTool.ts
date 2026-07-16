import {
    instanceClientModule,
    type ClientConnection,
    type JsonValue
} from "@portable-devshell/shared";

export function createCliClientTool(connection: ClientConnection) {
    const tool = instanceClientModule(connection, "tool");
    return {
        call: (instance: string, toolName: string, input: JsonValue): Promise<JsonValue> =>
            tool.request(instance, "call", { input, toolName })
    };
}

export type CliClientTool = ReturnType<typeof createCliClientTool>;
