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


export interface OAuthApprovalTokenRandomSource {
    getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export function generateOAuth2ApprovalToken(
    source: OAuthApprovalTokenRandomSource | null | undefined = globalThis.crypto,
): string {
    if (source === undefined || source === null || typeof source.getRandomValues !== "function") {
        throw new Error("A cryptographically secure random source is required to generate OAuth2 approval tokens.");
    }
    const bytes = new Uint8Array(32);
    source.getRandomValues(bytes);
    return `ds_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
