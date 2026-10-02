// Thin typed todo transport. get/delete are RPC operations; subscribe opens the
// server-filtered todo event stream.

import type { Endpoint } from "../../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../../transport/packet/Rpc.js";
import { Stream } from "../../../transport/packet/Stream.js";
import type { JsonValue } from "../../../transport/primitive/JsonValue.js";
import { InstanceEventStream } from "../../activity/EventStream.js";
import type { InstanceEventStreamPort } from "../../activity/Contract.js";
import { asInstanceName } from "../../identity/Model.js";
import {
    todoOperations,
    type TodoOperation,
    type TodoRequest,
    type TodoResponse,
} from "./Contract.js";
import type { TodoReadInput } from "./Model.js";

export const TODO_PORT = "todo";

export interface TodoTransport {
    delete(instance: string, taskId: string): Promise<Record<string, never>>;
    get(instance: string, input?: TodoReadInput): Promise<TodoResponse<"get">>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort>;
}

export function createTodoTransport(endpoint: Endpoint): TodoTransport {
    const request = async <Operation extends TodoOperation>(
        instance: string,
        operation: Operation,
        payload: TodoRequest<Operation>,
    ): Promise<TodoResponse<Operation>> => {
        const rpc = new Rpc(await endpoint.connect(instance, TODO_PORT));
        try {
            return await rpc.request<TodoResponse<Operation>>(
                operation,
                payload,
            );
        } finally {
            rpc.close();
        }
    };
    return {
        delete: (instance, taskId) =>
            request(instance, todoOperations.delete, { taskId }),
        get: (instance, input) => request(instance, todoOperations.get, input),
        subscribe: async (instance, fromSeq) => {
            const protocol = new Stream(
                await endpoint.connect(instance, TODO_PORT),
            );
            const stream = await protocol.open(todoOperations.subscribe, {
                fromSeq,
            } satisfies JsonValue);
            const close = () => protocol.close();
            stream.onClose(close);
            stream.onCancel(close);
            return new InstanceEventStream(asInstanceName(instance), stream);
        },
    };
}
