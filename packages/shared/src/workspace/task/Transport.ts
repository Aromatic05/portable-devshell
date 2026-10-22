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
    WaitRecord,
} from "./Model.js";

export interface TaskTransport {
    getGoal(ctxId: string): Promise<{ goal: GoalSnapshot | null; lastSeq: number }>;
    getGoals(): Promise<GoalSnapshotEnvelope>;
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
        getGoal: (ctxId) => port.request<{ goal: GoalSnapshot | null; lastSeq: number }>("getGoal", { ctxId }),
        getGoals: () => port.request<GoalSnapshotEnvelope>("getGoals"),
        getWaits: (ctxId) => port.request<{ waits: WaitRecord[]; lastSeq: number }>("getWaits", { ctxId }),
        subscribe: async (fromSeq) =>
            new InstanceEventStream<TaskEvent>(
                instanceName,
                await port.open("subscribe", { fromSeq }),
            ),
    };
}
