import type { OAuthApprovalRequest } from "@portable-devshell/shared";

import type { BoxModel } from "../../../component/content/Box.js";
import type { TuiAppState } from "../../../../state/store/Model.js";
import { compactSummary, makeBox } from "../../Support.js";

export function buildOAuthPageBoxes(
    state: TuiAppState,
    instanceName: string | undefined,
): BoxModel[] {
    const status = oauthRuntimeStatus(state);
    const approval = oauthApprovalConfig(state);
    const statusBox = makeBox(state, "connections", instanceName, {
        detailLines: [
            `Provider           ${status.provider}`,
            `Runtime            ${status.runtime}`,
            `Public base URL    ${status.publicBaseUrl}`,
            `Reason             ${status.reason}`,
            `Approval mode      ${approval.mode}`,
            `Approval token     ${approval.tokenConfigured ? "configured" : "not configured"}`,
            `Pending requests   ${state.readModel.oauthApprovals.filter((approval) => approval.status === "pending").length}`,
            ...(approval.mode === "token"
                ? [
                      {
                          id: "oauth.approval.tui",
                          text: "[ Use TUI Approval ]",
                      },
                      {
                          id: "oauth.approval.rotate",
                          text: "[ Rotate Approval Token ]",
                          tone: "danger" as const,
                      },
                  ]
                : [
                      {
                          id: "oauth.approval.token",
                          text: "[ Use Token Approval ]",
                          tone: "accent" as const,
                      },
                  ]),
        ],
        id: "oauth-runtime",
        status:
            status.runtime === "running"
                ? "ready"
                : status.runtime === "disabled"
                  ? "disabled"
                  : "failed",
        summaryLines: [
            compactSummary(
                ["provider", status.provider],
                ["runtime", status.runtime],
                [
                    "pending",
                    String(
                        state.readModel.oauthApprovals.filter(
                            (approval) => approval.status === "pending",
                        ).length,
                    ),
                ],
            ),
        ],
        title: "[Global] OAuth Runtime",
    });

    if (state.readModel.oauthApprovals.length === 0) {
        return [
            statusBox,
            makeBox(state, "connections", instanceName, {
                detailLines: [
                    "No OAuth registration or authorization requests are waiting for review.",
                ],
                id: "oauth-empty",
                summaryLines: ["pending=0"],
                title: "OAuth Approvals",
            }),
        ];
    }

    return [
        statusBox,
        ...state.readModel.oauthApprovals.map((approval) =>
            oauthApprovalBox(state, instanceName, approval),
        ),
    ];
}

function oauthApprovalBox(
    state: TuiAppState,
    instanceName: string | undefined,
    approval: OAuthApprovalRequest,
): BoxModel {
    return makeBox(state, "connections", instanceName, {
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
                      {
                          id: `oauth.deny:${approval.approvalId}`,
                          text: "[ Deny ]",
                          tone: "danger" as const,
                      },
                      {
                          id: `oauth.approve:${approval.approvalId}`,
                          text: "[ Approve ]",
                          tone: "accent" as const,
                      },
                  ]
                : []),
        ],
        id: `oauth-approval-${approval.approvalId}`,
        status:
            approval.status === "pending"
                ? "pending"
                : approval.status === "approved"
                  ? "ready"
                  : "failed",
        summaryLines: [
            compactSummary(
                ["kind", approval.kind],
                ["client", approval.clientName],
                ["status", approval.status],
            ),
        ],
        title: `OAuth ${approval.kind} approval`,
    });
}

function oauthRuntimeStatus(state: TuiAppState): {
    provider: string;
    publicBaseUrl: string;
    reason: string;
    runtime: string;
} {
    const status = state.readModel.mcpStatus;
    const provider =
        typeof status?.authMode === "string" ? status.authMode : "none";
    if (provider !== "oauth2") {
        return {
            provider,
            publicBaseUrl:
                typeof status?.publicBaseUrl === "string"
                    ? status.publicBaseUrl
                    : "unavailable",
            reason: "OAuth authentication is not enabled",
            runtime: "disabled",
        };
    }
    if (status?.running !== true) {
        return {
            provider,
            publicBaseUrl:
                typeof status?.publicBaseUrl === "string"
                    ? status.publicBaseUrl
                    : "unavailable",
            reason:
                typeof status?.reason === "string"
                    ? status.reason
                    : "MCP host is not listening",
            runtime: "stopped",
        };
    }
    if (status.oauthReady !== true) {
        return {
            provider,
            publicBaseUrl:
                typeof status?.publicBaseUrl === "string"
                    ? status.publicBaseUrl
                    : "unavailable",
            reason: "OAuth provider failed to initialize",
            runtime: "failed",
        };
    }
    return {
        provider,
        publicBaseUrl:
            typeof status?.publicBaseUrl === "string"
                ? status.publicBaseUrl
                : "unavailable",
        reason: "ready",
        runtime: "running",
    };
}

function oauthApprovalConfig(state: TuiAppState): {
    mode: "token" | "tui";
    tokenConfigured: boolean;
} {
    const mcp = asRecord(state.readModel.configView?.mcp);
    const oauth2 = asRecord(mcp?.oauth2);
    const mode = oauth2?.approval === "token" ? "token" : "tui";
    return {
        mode,
        tokenConfigured: mode === "token" && typeof oauth2?.token === "string",
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
