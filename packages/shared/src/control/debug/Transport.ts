import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
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
    const port = createPortClient(endpoint, CONTROL_HOST, "debug");
    return {
        list: () => port.request<DebugPatchSummary[]>("list"),
        load: (patch) => port.request<DebugPatchSummary>("load", patch),
        release: (patchId) =>
            port.request<DebugPatchSummary>("release", { patchId }),
        targets: () => port.request<DebugTargetSummary[]>("targets"),
        unload: (patchId) =>
            port.request<DebugPatchSummary>("unload", { patchId }),
    };
}
