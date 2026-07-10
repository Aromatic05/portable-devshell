export type OAuthApprovalDecision = "approve" | "deny";

export type OAuthApprovalKind = "authorization" | "registration";

export type OAuthApprovalStatus = "approved" | "denied" | "expired" | "pending";

export interface OAuthApprovalRequest {
    approvalId: string;
    clientId: string;
    clientName: string;
    createdAt: string;
    decidedAt?: string;
    decidedBy?: "cli" | "tui";
    expiresAt: string;
    kind: OAuthApprovalKind;
    redirectUris: string[];
    requestedResources: string[];
    requestedScopes: string[];
    status: OAuthApprovalStatus;
}
