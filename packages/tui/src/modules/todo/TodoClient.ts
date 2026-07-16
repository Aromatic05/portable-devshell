import {
    instanceClientModule,
    type ClientConnection,
    type TodoRpcEnvelope
} from "@portable-devshell/shared";

export function createTodoClient(connection: ClientConnection) {
    const todo = instanceClientModule(connection, "todo");
    return {
        get: (instance: string): Promise<TodoRpcEnvelope> => todo.request(instance, "get")
    };
}

export type TodoClient = ReturnType<typeof createTodoClient>;
