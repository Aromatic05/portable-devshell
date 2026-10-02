export type ExtensionContextStatus = "active" | "expired" | "disabled";

export interface ExtensionContextEnvironment {
    readonly instance: string;
    readonly workspace?: string;
}

export interface ExtensionContextRecord {
    readonly createdAt: string;
    readonly ctxId: string;
    readonly environments: readonly ExtensionContextEnvironment[];
    readonly expiresAt: string;
    readonly instance: string;
    readonly lastAccessedAt: string;
    readonly status: ExtensionContextStatus;
    readonly workspace: string;
}

export interface ExtensionContextQuery {
    readonly instance?: string;
    readonly status?: ExtensionContextStatus;
    readonly workspace?: string;
}

/** Read-only access to host-owned Context discovery state. */
export interface ExtensionContextObserveCapability {
    list(
        query?: ExtensionContextQuery,
    ): Promise<readonly ExtensionContextRecord[]>;
}
