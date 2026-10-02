export type ExtensionContextStatus = "active" | "expired" | "disabled";

export interface ExtensionContextEnvironment {
    readonly instance: string;
    readonly workspace?: string;
}

/** One Context attachment reached a terminal state for a specific Instance. */
export interface ExtensionContextEnvironmentRetiredEvent {
    readonly ctxId: string;
    readonly instance: string;
    readonly reason: "disabled" | "expired";
}

export interface ExtensionContextRecord {
    readonly createdAt: string;
    readonly ctxId: string;
    readonly environments: readonly ExtensionContextEnvironment[];
    readonly expiresAt: string;
    readonly lastAccessedAt: string;
    readonly status: ExtensionContextStatus;
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
