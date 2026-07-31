import type {
    ApprovalRequest,
    OAuthApprovalRequest,
} from "@portable-devshell/shared/browser";

export class ApprovalDecisionGuard {
    #tool = new Map<string, Set<string>>();
    #oauth = new Set<string>();

    recordTool(instance: string, approvalId: string): void {
        const ids = this.#tool.get(instance) ?? new Set<string>();
        ids.add(approvalId);
        this.#tool.set(instance, ids);
    }

    filterTool(instance: string, approvals: readonly ApprovalRequest[]): ApprovalRequest[] {
        const ids = this.#tool.get(instance);
        if (ids === undefined) return [...approvals];
        const present = new Set(approvals.map((approval) => approval.approvalId));
        for (const id of ids) {
            const current = approvals.find((approval) => approval.approvalId === id);
            if (!present.has(id) || current?.status !== "pending") ids.delete(id);
        }
        if (ids.size === 0) this.#tool.delete(instance);
        return approvals.filter(
            (approval) => approval.status !== "pending" || !ids.has(approval.approvalId),
        );
    }

    recordOAuth(approvalId: string): void {
        this.#oauth.add(approvalId);
    }

    filterOAuth(approvals: readonly OAuthApprovalRequest[]): OAuthApprovalRequest[] {
        const present = new Set(approvals.map((approval) => approval.approvalId));
        for (const id of this.#oauth) {
            const current = approvals.find((approval) => approval.approvalId === id);
            if (!present.has(id) || current?.status !== "pending") this.#oauth.delete(id);
        }
        return approvals.filter(
            (approval) => approval.status !== "pending" || !this.#oauth.has(approval.approvalId),
        );
    }
}
