import {
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../execution/process/Event.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type {
    GoalSnapshotEnvelope,
    TodoReadEnvelope,
    TodoReadInput,
} from "./Model.js";

export interface TaskTransport {
    deleteTodo(
        instance: string,
        taskId: string,
    ): Promise<Record<string, never>>;
    getGoals(instance: string): Promise<GoalSnapshotEnvelope>;
    getTodo(instance: string, input?: TodoReadInput): Promise<TodoReadEnvelope>;
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort>;
}

export function createTaskTransport(endpoint: Endpoint): TaskTransport {
    const port = (instance: string): PortClient =>
        createPortClient(endpoint, instance, "task");
    return {
        deleteTodo: (instance, taskId) =>
            port(instance).request<Record<string, never>>("deleteTodo", {
                taskId,
            }),
        getGoals: (instance) =>
            port(instance).request<GoalSnapshotEnvelope>("getGoals"),
        getTodo: (instance, input) =>
            port(instance).request<TodoReadEnvelope>("getTodo", input),
        subscribe: async (instance, fromSeq) =>
            new InstanceEventStream(
                asInstanceName(instance),
                await port(instance).open("subscribe", { fromSeq }),
            ),
    };
}
