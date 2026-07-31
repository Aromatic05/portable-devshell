import { useState } from "react";
import type { ApprovalRequest, OAuthApprovalRequest } from "@portable-devshell/shared/browser";

import { ConfirmationDialog } from "../components/ConfirmationDialog.js";
import { toolApprovals } from "../selectors/readModel.js";
import type { WebStore } from "../state/WebStore.js";

type Decision = "approve" | "deny";
type Selection = { approvalId: string; decision: Decision; kind: "oauth" | "tool"; label: string; instance?: string };

export function Approvals({ store }: { store: WebStore }) {
    const state = store.state;
    const tools = toolApprovals(state);
    const oauth = state.oauthApprovals.filter((item) => item.status === "pending");
    const [selection, setSelection] = useState<Selection>();
    const operation = selection === undefined ? undefined : `${selection.kind === "tool" ? "approval" : "oauth"}:${selection.approvalId}`;
    function decide(item: Selection): void { setSelection(item); }
    return <section>
        <h2>Approvals</h2>
        {tools.length + oauth.length === 0 ? <p className="empty">Nothing needs approval.</p> : <div className="approval-list">{tools.map((item) => <ToolApproval disabled={state.connection !== "online"} item={item} key={item.approvalId} onDecide={decide} />)}{oauth.map((item) => <OAuthApproval disabled={state.connection !== "online"} item={item} key={item.approvalId} onDecide={decide} />)}</div>}
        {selection !== undefined ? <ConfirmationDialog actionLabel={selection.decision === "approve" ? "Approve" : "Deny"} busy={operation !== undefined && state.operations[operation] !== undefined} description={`${selection.decision === "approve" ? "Approve" : "Deny"} ${selection.label}?`} onCancel={() => setSelection(undefined)} onConfirm={() => { const request = selection.kind === "tool" ? store.decideTool(selection.instance!, selection.approvalId, selection.decision) : store.decideOAuth(selection.approvalId, selection.decision); void request.finally(() => setSelection(undefined)); }} /> : null}
    </section>;
}

function ToolApproval({ disabled, item, onDecide }: { disabled: boolean; item: ApprovalRequest; onDecide(selection: Selection): void }) {
    return <article className="card"><h3>{item.toolName}</h3><p>{item.instance} · {item.reason}</p><details><summary>Open details</summary><p>Risk: {item.riskLevel}; expires: {item.expiresAt}</p><p>{item.inputSummary}</p></details><Decision disabled={disabled} item={{ approvalId: item.approvalId, instance: item.instance, kind: "tool", label: item.toolName }} onDecide={onDecide} /></article>;
}

function OAuthApproval({ disabled, item, onDecide }: { disabled: boolean; item: OAuthApprovalRequest; onDecide(selection: Selection): void }) {
    return <article className="card"><h3>OAuth {item.kind}</h3><p>{item.clientName} · {item.requestedScopes.join(", ") || "no scopes"}</p><details><summary>Open details</summary><p>Redirects: {item.redirectUris.join(", ") || "none"}</p><p>Resources: {item.requestedResources.join(", ") || "none"}</p></details><Decision disabled={disabled} item={{ approvalId: item.approvalId, kind: "oauth", label: `OAuth ${item.kind}` }} onDecide={onDecide} /></article>;
}

function Decision({ disabled, item, onDecide }: { disabled: boolean; item: Omit<Selection, "decision">; onDecide(selection: Selection): void }) {
    return <div className="actions"><button className="primary" disabled={disabled} onClick={() => onDecide({ ...item, decision: "approve" })}>Approve</button><button className="danger" disabled={disabled} onClick={() => onDecide({ ...item, decision: "deny" })}>Deny</button></div>;
}
