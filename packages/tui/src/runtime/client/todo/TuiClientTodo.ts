import {
    instanceClientModule,
    type ClientConnection,
    type TodoRpcEnvelope
} from "@portable-devshell/shared";

export function createTuiClientTodo(connection: ClientConnection) {
    const todo = instanceClientModule(connection, "todo");
    return {
        addComment: (instance: string, ctxId: string, text: string): Promise<void> => todo.request(instance, "addComment", { ctxId, text }),
        deleteComment: (instance: string, id: string): Promise<void> => todo.request(instance, "deleteComment", { id }),
        get: (instance: string): Promise<TodoRpcEnvelope> => todo.request(instance, "get")
    };
}

export type TuiClientTodo = ReturnType<typeof createTuiClientTodo>;
