/**
 * Context record model.
 *
 * Owns the MCP Context record acquired from a control host: its status,
 * environment attachments, and expiry/access timestamps. Context messages and
 * the Conversation surface live in their own subdomains.
 */

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
    /** Initial environment attached when the Context is acquired. It is not an authorization boundary. */
    instance: string;
    lastAccessedAt: string;
    principal: string;
    status: McpContextStatus;
    temporaryDirectory?: string;
    workspace: string;
}