import { CONTROL_HOST } from "../../client/Control.js";
import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import { createPortClient } from "../../transport/endpoint/PortClient.js";
import type {
    AuthStatus,
    OAuthApprovalDecision,
    OAuthApprovalRequest,
} from "./Model.js";

export interface AuthTransport {
    decideApproval(
        approvalId: string,
        decision: OAuthApprovalDecision,
    ): Promise<OAuthApprovalRequest>;
    listApprovals(): Promise<OAuthApprovalRequest[]>;
    status(): Promise<AuthStatus>;
}

export function createAuthTransport(endpoint: Endpoint): AuthTransport {
    const port = createPortClient(endpoint, CONTROL_HOST, "auth");
    return {
        decideApproval: (approvalId, decision) =>
            port.request<OAuthApprovalRequest>("decideApproval", {
                approvalId,
                decision,
            }),
        listApprovals: () =>
            port.request<OAuthApprovalRequest[]>("listApprovals"),
        status: () => port.request<AuthStatus>("status"),
    };
}
