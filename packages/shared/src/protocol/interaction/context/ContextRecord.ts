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
    lastAccessedAt: string;
    principal: string;
    status: McpContextStatus;
}
