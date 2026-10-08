import {
    InstanceEventStream,
    type InstanceEventStreamPort,
} from "../../client/Stream.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import { asInstanceName } from "../../types/Instance.js";
import type {
    GoalSnapshot,
    GoalSnapshotEnvelope,
    TaskEvent,
    TodoReadEnvelope,
    TodoReadInput,
    WaitRecord,
} from "./Model.js";

export interface TaskTransport {
    deleteTodo(taskId: string): Promise<Record<string, never>>;
    getGoal(ctxId: string): Promise<{ goal: GoalSnapshot | null; lastSeq: number }>;
    getGoals(): Promise<GoalSnapshotEnvelope>;
    getTodo(input?: TodoReadInput): Promise<TodoReadEnvelope>;
    getWaits(ctxId: string): Promise<{ waits: WaitRecord[]; lastSeq: number }>;
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
        getGoal: (ctxId) => port.request<{ goal: GoalSnapshot | null; lastSeq: number }>("getGoal", { ctxId }),
        getGoals: () => port.request<GoalSnapshotEnvelope>("getGoals"),
        getTodo: (input) => port.request<TodoReadEnvelope>("getTodo", input),
        getWaits: (ctxId) => port.request<{ waits: WaitRecord[]; lastSeq: number }>("getWaits", { ctxId }),
        subscribe: async (fromSeq) =>
            new InstanceEventStream<TaskEvent>(
                instanceName,
                await port.open("subscribe", { fromSeq }),
            ),
    };
}
