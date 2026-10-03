import type { Endpoint } from "../../transport/endpoint/Endpoint.js";
import {
    createPortClient,
    type PortClient,
} from "../../transport/endpoint/PortClient.js";
import { CONTROL_HOST } from "../connection/Control.js";
import {
    mcpOperations,
    type McpOperation,
    type McpRequest,
    type McpResponse,
} from "./Contract.js";
import type {
    McpRuntimeStatus,
    OAuthApprovalDecision,
    OAuthApprovalRequest,
} from "./Model.js";

export interface McpControlTransport {
    decideApproval(
        approvalId: string,
        decision: OAuthApprovalDecision,
    ): Promise<OAuthApprovalRequest>;
    listApprovals(): Promise<OAuthApprovalRequest[]>;
    status(): Promise<McpRuntimeStatus>;
}

export function createMcpControlTransport(endpoint: Endpoint): McpControlTransport {
    return mcpControlTransport(createPortClient(endpoint, CONTROL_HOST, "mcp"));
}

export function mcpControlTransport(
    port: PortClient,
): McpControlTransport {
    const request = <Operation extends McpOperation>(
        operation: Operation,
        payload: McpRequest<Operation>,
    ): Promise<McpResponse<Operation>> =>
        port.request<McpResponse<Operation>>(operation, payload);
    return {
        decideApproval: (approvalId, decision) =>
            request(mcpOperations.decideApproval, { approvalId, decision }),
        listApprovals: () => request(mcpOperations.listApprovals, undefined),
        status: () => request(mcpOperations.status, undefined),
    };
}