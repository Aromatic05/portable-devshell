export type ExtensionContextRuntimeStatus = "active" | "expired" | "disabled";

export interface ExtensionContextRuntimeEnvironment {
    readonly instance: string;
    readonly workspace?: string;
}

export interface ExtensionContextRuntimeRecord {
    readonly createdAt: string;
    readonly ctxId: string;
    readonly environments: readonly ExtensionContextRuntimeEnvironment[];
    readonly expiresAt: string;
    readonly instance: string;
    readonly lastAccessedAt: string;
    readonly status: ExtensionContextRuntimeStatus;
    readonly workspace: string;
}

export interface ExtensionContextRuntimeQuery {
    readonly instance?: string;
    readonly status?: ExtensionContextRuntimeStatus;
    readonly workspace?: string;
}

/** Read-only access to host-owned Context discovery state. */
export interface ExtensionContextRuntimeCapability {
    list(
        query?: ExtensionContextRuntimeQuery,
    ): Promise<readonly ExtensionContextRuntimeRecord[]>;
}
