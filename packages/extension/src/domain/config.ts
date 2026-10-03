import type { ExtensionJsonValue } from "../ExtensionCore.js";

export interface ExtensionConfigChange {
    readonly paths: readonly string[];
}

export interface ExtensionConfigStore {
    get(path: string): Promise<ExtensionJsonValue | undefined>;
    onChange(listener: (change: ExtensionConfigChange) => void): () => void;
    update(patch: Readonly<Record<string, ExtensionJsonValue>>): Promise<void>;
}

/** Scoped access to Core-owned Config paths exported by Control. */
export interface ExtensionCoreConfigCapability extends ExtensionConfigStore {}
