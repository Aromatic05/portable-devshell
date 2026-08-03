import {
    instanceClientModule,
    type ClientConnection,
    type TodoRpcEnvelope
} from "@portable-devshell/shared";

export function createTuiClientTodo(connection: ClientConnection) {
    const todo = instanceClientModule(connection, "todo");
    return {
        get: (instance: string, title?: string): Promise<TodoRpcEnvelope> =>
            todo.request(instance, "get", title === undefined ? {} : { title })
    };
}

export type TuiClientTodo = ReturnType<typeof createTuiClientTodo>;
