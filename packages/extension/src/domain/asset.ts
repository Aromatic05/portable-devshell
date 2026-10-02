/**
 * One immutable, content-addressed Extension asset bundle.
 *
 * generation is opaque to Extensions. directory is valid while the bundle is
 * installed; callers must not derive sibling paths or depend on Control's
 * physical storage layout.
 */
export interface ExtensionAssetBundle {
    readonly directory: string;
    readonly generation: string;
}

export interface ExtensionAssetProjectionResult {
    readonly transferredBytes: number;
}

export interface ExtensionAssetProjectionTarget {
    /** Logical resource collection owned by the Extension on the target Worker. */
    collection: string;
    /** Managed Worker instance receiving the resource. */
    instance: string;
    /** One logical entry name inside the collection; never a filesystem path. */
    key: string;
}

export interface ExtensionAssetProjectionInput {
    generation: string;
    overwrite?: boolean;
    signal?: AbortSignal;
    target: ExtensionAssetProjectionTarget;
}

/** Control-owned storage and transfer for Extension assets. */
export interface ExtensionAssetCapability {
    installBundle(sourcePath: string): Promise<ExtensionAssetBundle>;
    installDirectory(sourcePath: string): Promise<ExtensionAssetBundle>;
    listBundles(): Promise<readonly ExtensionAssetBundle[]>;
    projectBundle(
        input: ExtensionAssetProjectionInput,
    ): Promise<ExtensionAssetProjectionResult>;
    removeBundle(generation: string): Promise<void>;
    resolveBundle(
        generation: string,
    ): Promise<ExtensionAssetBundle | undefined>;
}
