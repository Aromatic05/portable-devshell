import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import { CONTROL_HOST } from "../connection/Control.js";
import {
    debugOperations,
    type DebugOperation,
    type DebugRequest,
    type DebugResponse,
} from "./Contract.js";
import type {
    DebugPatchLoadRequest,
    DebugPatchSummary,
    DebugTargetSummary,
} from "./Model.js";

export interface DebugTransport {
    list(): Promise<DebugPatchSummary[]>;
    load(request: DebugPatchLoadRequest): Promise<DebugPatchSummary>;
    release(patchId: string): Promise<DebugPatchSummary>;
    targets(): Promise<DebugTargetSummary[]>;
    unload(patchId: string): Promise<DebugPatchSummary>;
}

export function createDebugTransport(endpoint: Endpoint): DebugTransport {
    return debugTransport(createPortClient(endpoint, CONTROL_HOST, "debug"));
}

export function debugTransport(port: PortClient): DebugTransport {
    const request = <Operation extends DebugOperation>(
        operation: Operation,
        payload: DebugRequest<Operation>,
    ): Promise<DebugResponse<Operation>> =>
        port.request<DebugResponse<Operation>>(operation, payload);
    return {
        list: () => request(debugOperations.list, undefined),
        load: (patch) => request(debugOperations.load, patch),
        release: (patchId) => request(debugOperations.release, { patchId }),
        targets: () => request(debugOperations.targets, undefined),
        unload: (patchId) => request(debugOperations.unload, { patchId }),
    };
}