export type ApprovalPolicyMode = "disabled" | "allow" | "ask" | "deny";
export type ApprovalPolicyDecision = "allow" | "ask" | "deny";
export type ApprovalPolicySourceScope =
    | "all"
    | "cli"
    | "tui"
    | "web"
    | "mcp"
    | "extension";

export interface ApprovalPolicyRule {
    decision: ApprovalPolicyDecision;
    match: "exact";
    source: ApprovalPolicySourceScope;
    toolName?: string;
}

export interface ApprovalPolicy {
    mode: ApprovalPolicyMode;
    rules?: ApprovalPolicyRule[];
}
