import type { OAuthApprovalRequest } from "@portable-devshell/shared";

import type { BoxModel } from "../../component/ExpandableBox.js";
import type { TuiAppState } from "../TuiReducers.js";
import { compactSummary, makeBox } from "./PageBoxSupport.js";

export function buildOAuthPageBoxes(state: TuiAppState): BoxModel[] {
    if (state.oauthApprovals.length === 0) {
        return [
            makeBox(state, "oauth", undefined, {
                detailLines: ["No OAuth registration or authorization requests are waiting for review."],
                id: "oauth-empty",
                summaryLines: ["pending=0"],
                title: "OAuth Approvals"
            })
        ];
    }

    return state.oauthApprovals.map((approval) => oauthApprovalBox(state, approval));
}

function oauthApprovalBox(state: TuiAppState, approval: OAuthApprovalRequest): BoxModel {
    return makeBox(state, "oauth", undefined, {
        detailLines: [
            `kind ${approval.kind}`,
            `client ${approval.clientName}`,
            `clientId ${approval.clientId}`,
            `redirectUris ${approval.redirectUris.join(", ") || "-"}`,
            `scopes ${approval.requestedScopes.join(", ") || "-"}`,
            `resources ${approval.requestedResources.join(", ") || "-"}`,
            `createdAt ${approval.createdAt}`,
            `expiresAt ${approval.expiresAt}`,
            `status ${approval.status}`,
            ...(approval.status === "pending"
                ? [
                      { id: `oauth.approve:${approval.approvalId}`, text: "[ Approve ]", tone: "accent" as const },
                      { id: `oauth.deny:${approval.approvalId}`, text: "[ Deny ]", tone: "danger" as const }
                  ]
                : [])
        ],
        id: `oauth-approval-${approval.approvalId}`,
        status: approval.status === "pending" ? "pending" : approval.status === "approved" ? "ready" : "failed",
        summaryLines: [compactSummary(["kind", approval.kind], ["client", approval.clientName], ["status", approval.status])],
        title: `OAuth ${approval.kind} approval`
    });
}
