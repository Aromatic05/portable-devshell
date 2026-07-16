import {
    instanceClientModule,
    type ApprovalDecision,
    type ApprovalRequest,
    type ClientConnection,
    type JsonValue,
    type ToolCallQuery,
    type ToolCallRecord
} from "@portable-devshell/shared";

export interface ApprovalDecisionOptions {
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

export function createToolClient(connection: ClientConnection) {
    const tool = instanceClientModule(connection, "tool");
    return {
        call: (instance: string, toolName: string, input: JsonValue): Promise<JsonValue> =>
            tool.request(instance, "call", { input, toolName }),
        listCalls: (instance: string, params?: ToolCallQuery): Promise<ToolCallRecord[]> =>
            tool.request(instance, "listCalls", params),
        listApprovals: (instance: string): Promise<ApprovalRequest[]> =>
            tool.request(instance, "listApprovals"),
        getApproval: (instance: string, approvalId: string): Promise<ApprovalRequest> =>
            tool.request(instance, "getApproval", { approvalId }),
        decideApproval: (
            instance: string,
            approvalId: string,
            decision: ApprovalDecision["decision"],
            options: ApprovalDecisionOptions = {}
        ): Promise<ApprovalRequest> => tool.request(instance, "decideApproval", {
            approvalId,
            decision,
            ...options
        })
    };
}

export type ToolClient = ReturnType<typeof createToolClient>;
