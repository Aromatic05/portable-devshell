// Operational overview wire contract for the Control overview port. The
// transport in ./Transport.ts is typed against this map.

import type { OperationalOverview } from "./Model.js";

export const overviewOperations = {
    get: "get",
} as const;

export interface OverviewContract {
    get: {
        request: undefined;
        response: OperationalOverview;
    };
}

export type OverviewOperation = keyof OverviewContract;

export type OverviewRequest<Operation extends OverviewOperation> =
    OverviewContract[Operation]["request"];

export type OverviewResponse<Operation extends OverviewOperation> =
    OverviewContract[Operation]["response"];