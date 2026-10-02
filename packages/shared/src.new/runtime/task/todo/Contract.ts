// Todo wire contract. get returns the authoritative read plus the cursor;
// subscribe is server-filtered to todo events and resumes from that cursor.

import type { InstanceEventSubscribeRequest } from "../../activity/Contract.js";
import type { TodoReadEnvelope, TodoReadInput } from "./Model.js";

export const todoOperations = {
    delete: "delete",
    get: "get",
    subscribe: "subscribe",
} as const;

export interface TodoContract {
    delete: {
        request: { taskId: string };
        response: Record<string, never>;
    };
    get: {
        request: TodoReadInput | undefined;
        response: TodoReadEnvelope;
    };
}

export type TodoOperation = keyof TodoContract;

export type TodoRequest<Operation extends TodoOperation> =
    TodoContract[Operation]["request"];

export type TodoResponse<Operation extends TodoOperation> =
    TodoContract[Operation]["response"];

export type TodoSubscribeRequest = InstanceEventSubscribeRequest;
