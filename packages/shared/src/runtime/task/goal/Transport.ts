// Thin typed goal transport. Goals are read-only from the client side.

import type { Endpoint } from "../../../transport/endpoint/Endpoint.js";
import { Rpc } from "../../../transport/packet/Rpc.js";
import { goalOperations } from "./Contract.js";
import type { GoalSnapshotEnvelope } from "./Model.js";

export const GOAL_PORT = "goal";

export interface GoalTransport {
    get(instance: string): Promise<GoalSnapshotEnvelope>;
}

export function createGoalTransport(endpoint: Endpoint): GoalTransport {
    return {
        get: async (instance) => {
            const rpc = new Rpc(await endpoint.connect(instance, GOAL_PORT));
            try {
                return await rpc.request<GoalSnapshotEnvelope>(
                    goalOperations.get,
                    undefined,
                );
            } finally {
                rpc.close();
            }
        },
    };
}
