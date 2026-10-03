// Debug patch wire contract for the Control debug port. The transport in
// ./Transport.ts is typed against this map.

import type {
    DebugPatchLoadRequest,
    DebugPatchSummary,
    DebugTargetSummary,
} from "./Model.js";

export const debugOperations = {
    list: "list",
    load: "load",
    release: "release",
    targets: "targets",
    unload: "unload",
} as const;

export interface DebugContract {
    list: {
        request: undefined;
        response: DebugPatchSummary[];
    };
    load: {
        request: DebugPatchLoadRequest;
        response: DebugPatchSummary;
    };
    release: {
        request: { patchId: string };
        response: DebugPatchSummary;
    };
    targets: {
        request: undefined;
        response: DebugTargetSummary[];
    };
    unload: {
        request: { patchId: string };
        response: DebugPatchSummary;
    };
}

export type DebugOperation = keyof DebugContract;

export type DebugRequest<Operation extends DebugOperation> =
    DebugContract[Operation]["request"];

export type DebugResponse<Operation extends DebugOperation> =
    DebugContract[Operation]["response"];