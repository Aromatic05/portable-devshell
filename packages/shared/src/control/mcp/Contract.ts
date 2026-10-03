// MCP control wire contract for the Control mcp port. The transport in
// ./Transport.ts is typed against this map.

import type {
    McpRuntimeStatus,
    OAuthApprovalDecision,
    OAuthApprovalRequest,
} from "./Model.js";

export const mcpOperations = {
    decideApproval: "decideApproval",
    listApprovals: "listApprovals",
    status: "status",
} as const;

export interface McpContract {
    decideApproval: {
        request: { approvalId: string; decision: OAuthApprovalDecision };
        response: OAuthApprovalRequest;
    };
    listApprovals: {
        request: undefined;
        response: OAuthApprovalRequest[];
    };
    status: {
        request: undefined;
        response: McpRuntimeStatus;
    };
}

export type McpOperation = keyof McpContract;

export type McpRequest<Operation extends McpOperation> =
    McpContract[Operation]["request"];

export type McpResponse<Operation extends McpOperation> =
    McpContract[Operation]["response"];