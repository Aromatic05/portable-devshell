import {
    instanceClientModule,
    type ClientConnection,
    type TodoRpcEnvelope
} from "@portable-devshell/shared";

export function createTuiClientTodo(connection: ClientConnection) {
    const todo = instanceClientModule(connection, "todo");
    return {
        get: (instance: string): Promise<TodoRpcEnvelope> => todo.request(instance, "get")
    };
}

export type TuiClientTodo = ReturnType<typeof createTuiClientTodo>;
