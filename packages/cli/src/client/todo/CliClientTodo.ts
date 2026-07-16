import {
    instanceClientModule,
    type ClientConnection,
    type TodoRpcEnvelope
} from "@portable-devshell/shared";

import { createCliClientEventStream, type CliClientEventStream } from "../CliClientEventStream.js";

export function createCliClientTodo(connection: ClientConnection) {
    const todo = instanceClientModule(connection, "todo");
    return {
        get: (instance: string): Promise<TodoRpcEnvelope> => todo.request(instance, "get"),
        subscribe: async (instance: string, fromSeq: number): Promise<CliClientEventStream> =>
            createCliClientEventStream(instance, await todo.openStream(instance, "subscribe", { fromSeq }))
    };
}

export type CliClientTodo = ReturnType<typeof createCliClientTodo>;
