import type { ApprovalRequest } from "@portable-devshell/shared";
import type { McpAppActionGateway } from "../../instance/Gateway.js";
import type {
    McpAppAction,
    McpAppDecisionItem,
    McpAppResolvedAction,
} from "../model/Contract.js";
import { mcpAppIdentity } from "../model/Identity.js";

const actionView: Record<
    "approval-approve" | "approval-deny",
    Omit<McpAppAction, "id">
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
    const items: McpAppDecisionItem[] = [];
    const actions: McpAppResolvedAction[] = [];
    const primaryOrder: Array<{
        item: McpAppDecisionItem;
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
                    actionId: mcpAppIdentity(
                        ctxId,
                        instance,
                        approval.approvalId,
                        operation,
                    ),
                    instance,
                    operation,
                    targetId: approval.approvalId,
                });
        const item: McpAppDecisionItem = {
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
                          id: mcpAppIdentity(
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

export async function readApprovalContribution(
    gateway: McpAppActionGateway,
    ctxId: string,
    instances: readonly string[],
) {
    const slices = await Promise.allSettled(
        instances.map((instance) =>
            gateway.approval.listPendingApprovals(instance, ctxId),
        ),
    );
    return slices.reduce(
        (result, slice, index) => {
            if (slice.status !== "fulfilled") return result;
            const projection = contributeApprovals(
                slice.value,
                ctxId,
                instances[index]!,
                true,
            );
            result.items.push(...projection.items);
            result.actions.push(...projection.actions);
            result.primaryOrder.push(...projection.primaryOrder);
            return result;
        },
        {
            items: [] as ReturnType<typeof contributeApprovals>["items"],
            actions: [] as McpAppResolvedAction[],
            primaryOrder: [] as ReturnType<
                typeof contributeApprovals
            >["primaryOrder"],
        },
    );
}
