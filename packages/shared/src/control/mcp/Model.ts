import type { JsonValue } from "../../transport/primitive/JsonValue.js";

export interface McpRuntimeStatus extends Record<
    string,
    JsonValue | undefined
> {
    authMode?: "none" | "oauth2" | "token";
    oauthReady?: boolean;
    publicBaseUrl?: string;
    reason?: string;
    running: boolean;
}

/** OAuth2 approval decisions surfaced through the MCP control port. */
export type OAuthApprovalDecision = "approve" | "deny";

export type OAuthApprovalKind = "authorization" | "registration";

export type OAuthApprovalStatus = "approved" | "denied" | "expired" | "pending";

export interface OAuthApprovalRequest {
    approvalId: string;
    clientId: string;
    clientName: string;
    createdAt: string;
    decidedAt?: string;
    decidedBy?: "cli" | "tui" | "web";
    expiresAt: string;
    kind: OAuthApprovalKind;
    redirectUris: string[];
    requestedResources: string[];
    requestedScopes: string[];
    status: OAuthApprovalStatus;
}