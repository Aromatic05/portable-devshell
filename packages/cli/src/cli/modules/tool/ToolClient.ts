import {
    instanceClientModule,
    type ClientConnection,
    type JsonValue
} from "@portable-devshell/shared";

export function createToolClient(connection: ClientConnection) {
    const tool = instanceClientModule(connection, "tool");
    return {
        call: (instance: string, toolName: string, input: JsonValue): Promise<JsonValue> =>
            tool.request(instance, "call", { input, toolName })
    };
}

export type ToolClient = ReturnType<typeof createToolClient>;
