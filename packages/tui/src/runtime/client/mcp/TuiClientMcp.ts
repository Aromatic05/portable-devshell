import {
    controlClientModule,
    type ClientConnection,
    type JsonValue,
    type OAuthApprovalRequest
} from "@portable-devshell/shared";

export function createTuiClientMcp(connection: ClientConnection) {
    const mcp = controlClientModule(connection, "mcp");
    return {
        status: (): Promise<Record<string, JsonValue>> => mcp.request("status"),
        listApprovals: (): Promise<OAuthApprovalRequest[]> => mcp.request("listApprovals"),
        decideApproval: (
            approvalId: string,
            decision: "approve" | "deny"
        ): Promise<OAuthApprovalRequest> => mcp.request("decideApproval", { approvalId, decision })
    };
}

export type TuiClientMcp = ReturnType<typeof createTuiClientMcp>;
