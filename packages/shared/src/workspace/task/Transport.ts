import {
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type {
    GoalSnapshotEnvelope,
    TaskEvent,
    TodoReadEnvelope,
    TodoReadInput,
} from "./Model.js";

export interface TaskTransport {
    deleteTodo(taskId: string): Promise<Record<string, never>>;
    getGoals(): Promise<GoalSnapshotEnvelope>;
    getTodo(input?: TodoReadInput): Promise<TodoReadEnvelope>;
    subscribe(fromSeq: number): Promise<InstanceEventStreamPort<TaskEvent>>;
}

export function createTaskTransport(
    endpoint: Endpoint,
    instance: string,
): TaskTransport {
    const instanceName = asInstanceName(instance);
    const port = createPortClient(endpoint, instanceName, "task");
    return {
        deleteTodo: (taskId) =>
            port.request<Record<string, never>>("deleteTodo", {
                taskId,
            }),
        getGoals: () => port.request<GoalSnapshotEnvelope>("getGoals"),
        getTodo: (input) => port.request<TodoReadEnvelope>("getTodo", input),
        subscribe: async (fromSeq) =>
            new InstanceEventStream<TaskEvent>(
                instanceName,
                await port.open("subscribe", { fromSeq }),
            ),
    };
}
