export interface DebugInvocationSummary {
    completedAt?: string;
    invocationId: string;
    label?: string;
    method: string;
    outcome: "aborted" | "continued" | "faulted" | "holding" | "released" | "returned" | "thrown";
    startedAt: string;
}

export interface DebugPatchLoadRequest {
    name?: string;
    source: string;
    target: string;
}

export interface DebugPatchReleaseRequest {
    patchId: string;
}

export interface DebugPatchSummary {
    fault?: string;
    invocationCount: number;
    lastInvocation?: DebugInvocationSummary;
    loadedAt: string;
    name?: string;
    patchId: string;
    state: "active" | "faulted" | "unloaded";
    target: string;
    unloadedAt?: string;
}

export interface DebugPatchUnloadRequest {
    patchId: string;
}

export interface DebugTargetSummary {
    methods: string[];
    target: string;
}
