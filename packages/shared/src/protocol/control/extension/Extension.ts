export type ExtensionRuntimeState = "active" | "disabled" | "failed" | "installed";
export type ExtensionGenerationRuntimeState = "active" | "disposed" | "dispose-failed" | "draining" | "faulted" | "ready";

export interface ExtensionRuntimeFailure {
    generation?: string;
    message: string;
}

export interface ExtensionRetiredGenerationRecord {
    generation: string;
    inFlight: number;
    state: ExtensionGenerationRuntimeState;
}

export interface ExtensionRuntimeRecord {
    activeGeneration?: string;
    enabled: boolean;
    failure?: ExtensionRuntimeFailure;
    id: string;
    lastKnownGoodGeneration?: string;
    name?: string;
    retired: ExtensionRetiredGenerationRecord[];
    selectedGeneration?: string;
    state: ExtensionRuntimeState;
    version?: string;
}

export interface ExtensionRemoveResult {
    id: string;
    purged: boolean;
    removed: true;
}
