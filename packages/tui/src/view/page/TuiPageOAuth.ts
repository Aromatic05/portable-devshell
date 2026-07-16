import type { OAuthApprovalRequest } from "@portable-devshell/shared";

import type { BoxModel } from "../component/TuiComponentExpandableBox.js";
import type { TuiAppState } from "../../state/TuiStoreTypes.js";
import { compactSummary, makeBox } from "./TuiPageBoxSupport.js";

export function buildOAuthPageBoxes(state: TuiAppState): BoxModel[] {
    const status = oauthRuntimeStatus(state);
    const statusBox = makeBox(state, "oauth", undefined, {
        detailLines: [
            `Provider           ${status.provider}`,
            `Runtime            ${status.runtime}`,
            `Public base URL    ${status.publicBaseUrl}`,
            `Reason             ${status.reason}`,
            `Pending requests   ${state.oauthApprovals.filter((approval) => approval.status === "pending").length}`
        ],
        id: "oauth-runtime",
        status: status.runtime === "running" ? "ready" : status.runtime === "disabled" ? "disabled" : "failed",
        summaryLines: [compactSummary(["provider", status.provider], ["runtime", status.runtime], ["pending", String(state.oauthApprovals.filter((approval) => approval.status === "pending").length)])],
        title: "[Global] OAuth Runtime"
    });

    if (state.oauthApprovals.length === 0) {
        return [
            statusBox,
            makeBox(state, "oauth", undefined, {
                detailLines: ["No OAuth registration or authorization requests are waiting for review."],
                id: "oauth-empty",
                summaryLines: ["pending=0"],
                title: "OAuth Approvals"
            })
        ];
    }

    return [statusBox, ...state.oauthApprovals.map((approval) => oauthApprovalBox(state, approval))];
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
                      { id: `oauth.deny:${approval.approvalId}`, text: "[ Deny ]", tone: "danger" as const },
                      { id: `oauth.approve:${approval.approvalId}`, text: "[ Approve ]", tone: "accent" as const }
                  ]
                : [])
        ],
        id: `oauth-approval-${approval.approvalId}`,
        status: approval.status === "pending" ? "pending" : approval.status === "approved" ? "ready" : "failed",
        summaryLines: [compactSummary(["kind", approval.kind], ["client", approval.clientName], ["status", approval.status])],
        title: `OAuth ${approval.kind} approval`
    });
}

function oauthRuntimeStatus(state: TuiAppState): { provider: string; publicBaseUrl: string; reason: string; runtime: string } {
    const status = state.mcpStatus;
    const provider = typeof status?.authMode === "string" ? status.authMode : "none";
    if (provider !== "oauth2") {
        return { provider, publicBaseUrl: typeof status?.publicBaseUrl === "string" ? status.publicBaseUrl : "unavailable", reason: "OAuth authentication is not enabled", runtime: "disabled" };
    }
    if (status?.running !== true) {
        return { provider, publicBaseUrl: typeof status?.publicBaseUrl === "string" ? status.publicBaseUrl : "unavailable", reason: typeof status?.reason === "string" ? status.reason : "MCP host is not listening", runtime: "stopped" };
    }
    if (status.oauthReady !== true) {
        return { provider, publicBaseUrl: typeof status?.publicBaseUrl === "string" ? status.publicBaseUrl : "unavailable", reason: "OAuth provider failed to initialize", runtime: "failed" };
    }
    return { provider, publicBaseUrl: typeof status?.publicBaseUrl === "string" ? status.publicBaseUrl : "unavailable", reason: "ready", runtime: "running" };
}
