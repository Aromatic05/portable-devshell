export type McpContextStatus = "active" | "expired" | "disabled";

export interface McpContextRecord {
    createdAt: string;
    ctxId: string;
    expiresAt: string;
    instance: string;
    lastAccessedAt: string;
    principal: string;
    status: McpContextStatus;
    temporaryDirectory?: string;
    workspace: string;
}
