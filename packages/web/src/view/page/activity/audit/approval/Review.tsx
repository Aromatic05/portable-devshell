import { useEffect, useRef, useState } from "react";
import type { ApprovalRequest } from "@portable-devshell/shared";
import type { WebStore } from "../../../../../state/Store.js";
import { approvalOperationKey } from "../../../../../state/Operation.js";
import { ConfirmationDialog } from "../../../../component/Confirm.js";

export type ApprovalReviewSelection = { approval: ApprovalRequest; decision: "approve" | "deny" };

export function ApprovalActions({ approval, disabled, pending, onReview }: {
    approval: ApprovalRequest;
    disabled: boolean;
    pending: boolean;
    onReview(selection: ApprovalReviewSelection): void;
}) {
    return (
        <span className="audit-approval-actions" onClick={(event) => {
            event.preventDefault(); event.stopPropagation();
        }}>
            <button className="primary" disabled={disabled || pending}
                onClick={() => onReview({ approval, decision: "approve" })} type="button">Approve</button>
            <button className="danger subtle" disabled={disabled || pending}
                onClick={() => onReview({ approval, decision: "deny" })} type="button">Deny</button>
        </span>
    );
}

export function ApprovalReview({ selection, available, disabled, pending, store, onClose }: {
    selection: ApprovalReviewSelection;
    available: boolean;
    disabled: boolean;
    pending: boolean;
    store: WebStore;
    onClose(): void;
}) {
    const { approval, decision } = selection;
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string>();
    const epoch = useRef(0);
    const working = useRef(false);
    useEffect(() => {
        epoch.current += 1;
        return () => { epoch.current += 1; };
    }, []);
    useEffect(() => {
        if (!available && !busy && failure === undefined) onClose();
    }, [available, busy, failure, onClose]);
    async function confirm(): Promise<void> {
        if (working.current || pending || disabled) return;
        working.current = true;
        setBusy(true);
        setFailure(undefined);
        const requestEpoch = epoch.current;
        const succeeded = await store.decideTool(approval.instance, approval.approvalId, decision);
        if (requestEpoch !== epoch.current) return;
        working.current = false;
        setBusy(false);
        if (succeeded) onClose();
        else setFailure(store.operationFailure(approvalOperationKey(approval.instance, approval.approvalId)) ?? "Approval could not be recorded.");
    }
    return <ConfirmationDialog
        actionLabel={decision === "approve" ? "Approve" : "Deny"}
        busy={busy || pending}
        description={`${decision === "approve" ? "Approve" : "Deny"} ${approval.toolName} on ${approval.instance}${approval.workspace === undefined ? "" : ` in ${approval.workspace}`}? ${approval.reason}`}
        disabled={disabled}
        error={failure}
        onCancel={onClose}
        onConfirm={() => void confirm()}
        variant={decision === "deny" ? "destructive" : "default"}
    />;
}
