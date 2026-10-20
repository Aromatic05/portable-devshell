import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { asInstanceName, type ApprovalRequest } from "@portable-devshell/shared";
import { afterEach, expect, it, vi } from "vitest";
import { Application } from "../../../src/app/Application.js";
import { Audit } from "../../../src/view/page/activity/audit/Page.js";
import { WebStore } from "../../../src/state/Store.js";
import type { AuditScope } from "../../../src/app/Route.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";
import { approvalPeer } from "../../support/ApprovalPeer.js";
import { auditCall, deferred } from "../../support/BetaMatrixHarness.js";

function request(instance = "alpha", id = "review"): ApprovalRequest {
    return {
        approvalId: id, callId: "not-executed-yet", instance: asInstanceName(instance),
        ctxId: "ctx-review", toolName: "bash_run", workspace: "/project/review",
        inputSummary: '{"command":"deploy"}', reason: `Review ${instance} deployment`,
        status: "pending", source: "mcp", riskLevel: "high",
        createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z",
    };
}

function fixture(scope: AuditScope = { kind: "all" }) {
    const domains = new WebTestDomains();
    domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    domains.setApprovals("alpha", [request()]);
    const store = new WebStore(domains.domains);
    const view = (nextScope = scope) => withWebDomains(domains, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: nextScope }} />);
    return { domains, store, view, ...render(view()) };
}

it("L03 RED: pending review is actionable with zero ToolCall audit rows, then approves without fabricating history", async () => {
    const { domains, container } = fixture();
    const decide = vi.spyOn(domains.approval("alpha"), "decide").mockImplementation(async () => domains.setApprovals("alpha", []));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(container.querySelectorAll(".tool-call-record")).toHaveLength(0);
    expect(screen.getByText("Review alpha deployment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledExactlyOnceWith("review", "approve"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(container.querySelectorAll(".tool-call-record")).toHaveLength(0);
    expect(domains.toolCalls.state.instances).toEqual({});
});

it("L03 RED: instance and Context scope restrict standalone approvals to the actual available instance", () => {
    const { domains, rerender, view } = fixture({ kind: "instance", instance: "beta" });
    act(() => {
        domains.setApprovals("beta", [request("beta")]);
        domains.setApprovals("phantom", [request("phantom")]);
    });
    expect(screen.getByText("Review beta deployment")).toBeInTheDocument();
    expect(screen.queryByText("Review alpha deployment")).not.toBeInTheDocument();
    expect(screen.queryByText("Review phantom deployment")).not.toBeInTheDocument();
    rerender(view({ kind: "context", instance: "alpha", ctxId: "other-context" }));
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    rerender(view({ kind: "context", instance: "alpha", ctxId: "ctx-review" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
});

it("L03 RED: optimistic removal during a denied review must keep the pending dialog and original backend failure for retry", async () => {
    const { domains } = fixture();
    const pending = deferred<void>();
    const decide = vi.spyOn(domains.approval("alpha"), "decide").mockImplementationOnce(async () => {
        domains.setApprovals("alpha", []); await pending.promise;
    }).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(decide).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await act(async () => pending.reject(new Error("Reviewer revision 42 refused denial")));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Reviewer revision 42 refused denial");
    act(() => domains.setApprovals("alpha", [request()]));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(decide.mock.calls).toEqual([["review", "deny"], ["review", "deny"]]);
});

const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });

async function realFixture() {
    const peer = await approvalPeer(["alpha", "beta"]); dispose.push(() => peer.close());
    const domains = new WebTestDomains(); domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    domains.domains.approval = (instance) => peer.models.get(instance)!;
    const store = new WebStore(domains.domains);
    const view = (scope: AuditScope = { kind: "all" }) => withWebDomains(domains, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope }} />);
    return { peer, domains, store, view };
}

it.each(["approve", "deny"] as const)("production Approval projection loads zero-history review and dispatches %s over framed RPC", async (decision) => {
    const { peer, domains, view } = await realFixture();
    await peer.put("alpha", [request()]);
    const mounted = render(view());
    const label = decision === "approve" ? "Approve" : "Deny";
    expect(await screen.findByRole("button", { name: label })).toBeEnabled();
    await waitFor(() => expect(peer.subscribers("alpha")).toBe(1));
    const pending = deferred<void>(); peer.hooks.decide = async () => pending.promise;
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
    await waitFor(() => expect(peer.decisions).toEqual([{ instance: "alpha", approvalId: "review", decision }]));
    expect(peer.models.get("alpha")!.state.approvals).toHaveLength(0);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(domains.toolCalls.state.instances).toEqual({});
    expect(mounted.container.querySelectorAll(".tool-call-record")).toHaveLength(0);
    mounted.unmount();
});

it("real approval stream supplies a new request after navigation, and fresh projections restore it on remount", async () => {
    const { peer, view } = await realFixture();
    const mounted = render(view());
    await waitFor(() => expect(peer.subscribers("alpha")).toBe(1));
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    await act(async () => peer.put("alpha", [request()]));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    expect(peer.snapshots.filter((instance) => instance === "alpha").length).toBeGreaterThanOrEqual(2);
    mounted.unmount(); peer.reset();
    const remounted = render(view({ kind: "context", instance: "alpha", ctxId: "ctx-review" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    await act(async () => peer.put("alpha", []));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument());
    remounted.unmount();
});

it("real snapshot failure displays the current error and explicit retry retrieves pending approvals", async () => {
    const { peer, view } = await realFixture();
    await peer.put("alpha", [request()]);
    peer.hooks.snapshot = vi.fn().mockRejectedValueOnce(new Error("Approval snapshot revision 17 is locked")).mockResolvedValue(undefined);
    const mounted = render(view());
    expect(await screen.findByRole("alert")).toHaveTextContent("Approval snapshot revision 17 is locked");
    fireEvent.click(screen.getByRole("button", { name: "Retry approvals" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    mounted.unmount();
});

it("real optimistic removal retains exact backend failure and review context until a successful retry", async () => {
    const { peer, store, view } = await realFixture(); await peer.put("alpha", [request()]);
    const pending = deferred<void>(); peer.hooks.decide = vi.fn().mockImplementationOnce(async () => pending.promise).mockResolvedValue(undefined);
    const mounted = render(view());
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(peer.decisions).toHaveLength(1));
    expect(peer.models.get("alpha")!.state.approvals).toHaveLength(0);
    await act(async () => pending.reject(new Error("Policy revision 42 rejected denial")));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Policy revision 42 rejected denial");
    expect(screen.getByRole("dialog")).toHaveTextContent("Review alpha deployment");
    await waitFor(() => expect(peer.models.get("alpha")!.state.approvals).toHaveLength(1));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(peer.decisions).toEqual([
        { instance: "alpha", approvalId: "review", decision: "deny" },
        { instance: "alpha", approvalId: "review", decision: "deny" },
    ]);
    expect(store.state.error).toBeUndefined(); mounted.unmount();
});

it("standalone and attached reviews deduplicate by instance and call identity across audit arrival", () => {
    const { domains, container } = fixture();
    act(() => {
        domains.setApprovals("beta", [request("beta")]);
        domains.setToolCalls("alpha", [{ ...auditCall, callId: "not-executed-yet" }]);
    });
    expect(container.querySelectorAll(".approval-record")).toHaveLength(1);
    expect(container.querySelectorAll(".tool-call-record")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
    act(() => domains.setToolCalls("beta", [{ ...auditCall, instance: "beta", callId: "not-executed-yet" }]));
    expect(container.querySelectorAll(".approval-record")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
});

it("identical approval ids from two instances can be pending concurrently and one failure never changes the other review", async () => {
    const { domains } = fixture(); act(() => domains.setApprovals("beta", [request("beta")]));
    const alpha = deferred<void>(), beta = deferred<void>();
    const decideAlpha = vi.spyOn(domains.approval("alpha"), "decide").mockReturnValue(alpha.promise);
    const decideBeta = vi.spyOn(domains.approval("beta"), "decide").mockReturnValue(beta.promise);
    const alphaRow = screen.getByText("Review alpha deployment").closest("li")!;
    const betaRow = screen.getByText("Review beta deployment").closest("li")!;
    fireEvent.click(within(alphaRow).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decideAlpha).toHaveBeenCalledOnce());
    expect(within(alphaRow).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(betaRow).getByRole("button", { name: "Deny" })).toBeEnabled();
    fireEvent.click(within(betaRow).getByRole("button", { name: "Deny" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(decideBeta).toHaveBeenCalledOnce());
    await act(async () => alpha.reject(new Error("Alpha approval rejected")));
    expect(screen.getByRole("dialog")).toHaveTextContent("Review beta deployment");
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => beta.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(decideAlpha).toHaveBeenCalledExactlyOnceWith("review", "approve");
    expect(decideBeta).toHaveBeenCalledExactlyOnceWith("review", "deny");
});

it("UI filters apply to standalone reviews while explicit Context scope remains authoritative", () => {
    const { domains, rerender, view } = fixture();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search audit" }), { target: { value: "not-in-the-request" } });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search audit" }), { target: { value: "deploy" } });
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Failures" }));
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pending" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(within(screen.getByRole("combobox", { name: "Tool" })).getByRole("option", { name: "bash_run" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Workspace" }), { target: { value: "other-project" } });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Workspace" }), { target: { value: "review" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Context ID" }), { target: { value: "other-ctx" } });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Context ID" }), { target: { value: "ctx-review" } });
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    act(() => domains.setContexts([{ ctxId: "ctx-review", status: "disabled", lastAccessedAt: new Date().toISOString(), environments: [{ instance: "alpha", workspace: "/project/review" }] }]));
    fireEvent.change(screen.getByRole("combobox", { name: "Context status" }), { target: { value: "active" } });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    rerender(view({ kind: "context", instance: "alpha", ctxId: "ctx-review" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
});

it("late snapshot errors for a removed instance cannot hide its replacement, and offline state blocks decisions", async () => {
    const domains = new WebTestDomains(); domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    const pending = deferred<void>();
    const load = vi.spyOn(domains.approval("alpha"), "load").mockReturnValue(pending.promise);
    const store = new WebStore(domains.domains);
    const view = (scope: AuditScope) => withWebDomains(domains, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope }} />);
    const { rerender } = render(view({ kind: "instance", instance: "alpha" }));
    expect(load).toHaveBeenCalledOnce();
    act(() => {
        domains.setApprovals("beta", [request("beta")]);
        domains.setInstances([{ name: "beta" }]);
    });
    rerender(view({ kind: "instance", instance: "beta" }));
    await act(async () => pending.reject(new Error("Detached alpha read failed")));
    expect(screen.getByText("Review beta deployment")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => domains.server.patch({ status: "offline" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    act(() => domains.server.patch({ status: "online" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
});

it("tool and time filters select the actual pending requests instead of unrelated audit tools", () => {
    const { domains } = fixture();
    act(() => domains.setApprovals("alpha", [request(), {
        ...request("alpha", "old-file"), callId: "old-file-call", toolName: "file_read", reason: "Review old file access",
        createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    }]));
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Tool" }), { target: { value: "file_read" } });
    expect(screen.getByText("Review old file access")).toBeInTheDocument();
    expect(screen.queryByText("Review alpha deployment")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Time range" }), { target: { value: "1h" } });
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Tool" }), { target: { value: "bash_run" } });
    expect(screen.getByText("Review alpha deployment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Success" }));
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pending" }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
});

it("audit arrival moves the action onto its call without closing or duplicating the active review", async () => {
    const { domains, container } = fixture();
    const decide = vi.spyOn(domains.approval("alpha"), "decide");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    act(() => domains.setToolCalls("alpha", [{ ...auditCall, callId: "not-executed-yet" }]));
    expect(container.querySelectorAll(".approval-record")).toHaveLength(0);
    expect(container.querySelectorAll(".tool-call-record")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveTextContent("Review alpha deployment");
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(decide).toHaveBeenCalledExactlyOnceWith("review", "approve");
});

it("recreated approval domains for the same instance name load fresh snapshots instead of retaining closed projections", async () => {
    const { peer, domains, view } = await realFixture(); await peer.put("alpha", [request()]);
    const mounted = render(view());
    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    await act(async () => {
        peer.reset();
        await peer.put("alpha", [{ ...request("alpha", "replacement"), reason: "Fresh instance review" }]);
        domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    });
    expect(await screen.findByText("Fresh instance review")).toBeInTheDocument();
    expect(screen.queryByText("Review alpha deployment")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled(); mounted.unmount();
});


it("Application navigation reports an approval snapshot failure without unhandled rejection and Refresh all recovers", async () => {
    const { peer, store } = await realFixture(); await peer.put("alpha", [request()]);
    const failures = new Map([["alpha", new Error("Audit approval snapshot is unavailable")]]);
    peer.hooks.snapshot = async (instance) => { const failure = failures.get(instance); if (failure !== undefined) throw failure; };
    const previousHash = window.location.hash;
    window.history.replaceState(null, "", "#/audit");
    dispose.push(() => window.history.replaceState(null, "", previousHash));
    const mounted = render(<Application store={store} onLogout={async () => undefined} onReconnect={async () => undefined} />);
    expect(await screen.findByText(/Could not load approvals for alpha:/u)).toHaveTextContent("Audit approval snapshot is unavailable");
    await waitFor(() => expect(store.state.error).toContain("Audit approval snapshot is unavailable"));
    failures.clear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    await waitFor(() => expect(store.state.error).toBeUndefined());
    expect(screen.queryByText(/Could not load approvals for alpha:/u)).not.toBeInTheDocument(); mounted.unmount();
});
