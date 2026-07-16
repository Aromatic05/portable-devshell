import type { InstanceSnapshot } from "./DtoInstanceSnapshot.js";

export interface InstanceRuntimeEnvelope {
    lastSeq: number;
    snapshot: InstanceSnapshot;
}

export interface InstanceListEntry {
    mcpEnabled: boolean;
    name: string;
    snapshot: InstanceSnapshot;
}
