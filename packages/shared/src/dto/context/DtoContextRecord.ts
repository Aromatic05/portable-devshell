export type McpContextStatus = "active" | "expired" | "disabled";

export interface McpContextEnvironment {
    instance: string;
    temporaryDirectory?: string;
    workspace?: string;
}

export interface McpContextRecord {
    createdAt: string;
    ctxId: string;
    environments: McpContextEnvironment[];
    expiresAt: string;
    /** Initial environment selected by environ_info. It is not an authorization boundary. */
    instance: string;
    lastAccessedAt: string;
    principal: string;
    status: McpContextStatus;
    temporaryDirectory?: string;
    workspace: string;
}
