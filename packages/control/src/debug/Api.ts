import type { Instance, InstanceRegistry } from "@portable-devshell/core";
import type {
    DebugPatchLoadRequest,
    DebugPatchSummary,
    DebugTargetSummary,
} from "@portable-devshell/shared";

export interface DebugApi {
    listPatches(): DebugPatchSummary[];
    listTargets(): DebugTargetSummary[];
    load(request: DebugPatchLoadRequest): Promise<DebugPatchSummary>;
    release(patchId: string): DebugPatchSummary;
    unload(patchId: string): Promise<DebugPatchSummary>;
}

export interface DebugRuntime extends DebugApi {
    close(): Promise<void>;
    retireInstance(name: string): Promise<void>;
}

export interface DebugRuntimeOptions {
    instances: InstanceRegistry;
    target(instance: Instance): object;
}
