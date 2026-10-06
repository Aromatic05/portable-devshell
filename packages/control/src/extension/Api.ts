import type { ExtensionContextEnvironmentRetiredEvent } from "@portable-devshell/extension/context";
import type {
    ExtensionRemoveResult,
    ExtensionPublicRuntimeRecord,
    ExtensionRuntimeRecord,
} from "@portable-devshell/shared";

import type { ExtensionCatalogRegistration } from "./discovery/Catalog.js";
import type { ExtensionGenerationLease } from "./registration/Generation.js";
import type { ExtensionRuntimeRegistration } from "./registration/Registration.js";

export interface ExtensionRegistrationLease {
    extensionId: string;
    lease: ExtensionGenerationLease;
    registration: ExtensionRuntimeRegistration;
}

export interface ExtensionControlPort {
    disable(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    install(sourcePath: string): Promise<ExtensionRuntimeRecord>;
    list(): Promise<ExtensionRuntimeRecord[]>;
    reload(id: string): Promise<void>;
    remove(id: string, purge: boolean): Promise<ExtensionRemoveResult>;
}

export interface ExtensionRuntime {
    readonly control: ExtensionControlPort;
    acquire(id: string): ExtensionGenerationLease;
    acquireRegistration(
        pointId: string,
        id: string,
    ): Promise<ExtensionRegistrationLease>;
    activateGeneration(id: string, generation: string): Promise<void>;
    contextEnvironmentRetired(
        input: ExtensionContextEnvironmentRetiredEvent,
    ): Promise<void>;
    disable(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    forget(id: string): Promise<void>;
    generationDirectory(id: string, generation: string): string;
    installBuiltin(
        id: string,
        sourcePath: string,
    ): Promise<ExtensionRuntimeRecord>;
    list(): Promise<ExtensionRuntimeRecord[]>;
    listDeclarations(pointId: string): readonly ExtensionCatalogRegistration[];
    onChange(listener: () => void): () => void;
    readPublicState<Result>(
        read: (state: {
            extensions: ExtensionPublicRuntimeRecord[];
            revision: number;
        }) => Result,
    ): Promise<Result>;
    reload(id: string): Promise<void>;
    retireInstanceGeneration(instance: string): Promise<void>;
    selectGeneration(id: string, generation: string): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    waitForDrain(id: string): Promise<void>;
}
