import {
    instanceClientModule,
    type ClientConnection,
    type TodoRpcEnvelope
} from "@portable-devshell/shared";

import { clientEventStream, type ClientEventStream } from "../../client/ClientEventStream.js";

export function createTodoClient(connection: ClientConnection) {
    const todo = instanceClientModule(connection, "todo");
    return {
        get: (instance: string): Promise<TodoRpcEnvelope> => todo.request(instance, "get"),
        subscribe: async (instance: string, fromSeq: number): Promise<ClientEventStream> =>
            clientEventStream(instance, await todo.openStream(instance, "subscribe", { fromSeq }))
    };
}

export type TodoClient = ReturnType<typeof createTodoClient>;
