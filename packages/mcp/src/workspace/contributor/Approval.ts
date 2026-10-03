import type { ApprovalRequest } from "@portable-devshell/shared";
import type {
    WorkspaceAction,
    WorkspaceDecisionItem,
    WorkspaceResolvedAction,
} from "../Contract.js";
import { workspaceIdentity } from "../Identity.js";

const actionView: Record<
    "approval-approve" | "approval-deny",
    Omit<WorkspaceAction, "id">
> = {
    "approval-approve": { label: "Approve", tone: "primary" },
    "approval-deny": { label: "Deny", tone: "danger" },
};

export function contributeApprovals(
    approvals: ApprovalRequest[],
    ctxId: string,
    instance: string,
    decideAvailable: boolean,
) {
    const items: WorkspaceDecisionItem[] = [];
    const actions: WorkspaceResolvedAction[] = [];
    const primaryOrder: Array<{
        item: WorkspaceDecisionItem;
        rank: number;
        updatedAt: string;
    }> = [];
    for (const approval of approvals) {
        if (approval.ctxId !== ctxId || approval.status !== "pending") continue;
        if (decideAvailable)
            for (const operation of [
                "approval-approve",
                "approval-deny",
            ] as const)
                actions.push({
                    itemId: approval.approvalId,
                    actionId: workspaceIdentity(
                        ctxId,
                        instance,
                        approval.approvalId,
                        operation,
                    ),
                    instance,
                    operation,
                    targetId: approval.approvalId,
                });
        const item: WorkspaceDecisionItem = {
            kind: "decision",
            id: approval.approvalId,
            title: approval.toolName,
            ...(approval.riskLevel ? { badge: approval.riskLevel } : {}),
            ...(approval.inputSummary
                ? { summary: approval.inputSummary }
                : {}),
            ...(approval.reason ? { detail: approval.reason } : {}),
            actions: decideAvailable
                ? (["approval-approve", "approval-deny"] as const).map(
                      (operation) => ({
                          id: workspaceIdentity(
                              ctxId,
                              instance,
                              approval.approvalId,
                              operation,
                          ),
                          ...actionView[operation],
                      }),
                  )
                : [],
        };
        items.push(item);
        primaryOrder.push({ item, rank: 0, updatedAt: approval.createdAt });
    }
    return { items, actions, primaryOrder };
}
