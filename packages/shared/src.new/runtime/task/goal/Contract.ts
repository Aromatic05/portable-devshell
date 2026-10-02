// Goal wire contract. get returns goals plus the instance sequence cursor.

import type { GoalSnapshotEnvelope } from "./Model.js";

export const goalOperations = {
    get: "get",
} as const;

export interface GoalContract {
    get: {
        request: undefined;
        response: GoalSnapshotEnvelope;
    };
}

export type GoalOperation = keyof GoalContract;

export type GoalRequest<Operation extends GoalOperation> =
    GoalContract[Operation]["request"];

export type GoalResponse<Operation extends GoalOperation> =
    GoalContract[Operation]["response"];
