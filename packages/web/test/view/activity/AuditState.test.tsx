import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Audit } from "../../../src/view/page/activity/audit/Page.js";
import { WebStore } from "../../../src/state/Store.js";
import { approvalOperationKey } from "../../../src/state/Operation.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";
import { auditCall, deferred, setupAudit } from "../../support/BetaMatrixHarness.js";
import { round4Calls } from "../../support/Round4Harness.js";
import { registerRound4WebDefects } from "../../support/Round4Defects.js";

registerRound4WebDefects();

it("clamps shrink to the last available page and keeps the clamped page when rows regrow", () => {
    const domains = new WebTestDomains(); domains.setInstances([{ name: "alpha" }]);
    domains.setToolCalls("alpha", round4Calls(65));
    render(withWebDomains(domains, <Audit store={new WebStore(domains.domains)} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: { kind: "all" } }} />));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    act(() => domains.setToolCalls("alpha", round4Calls(25)));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("Showing 21-25 of 25 loaded matching tool calls.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    act(() => domains.setToolCalls("alpha", []));
    expect(screen.queryByRole("navigation", { name: "Tool calls pagination" })).not.toBeInTheDocument();
    act(() => domains.setToolCalls("alpha", round4Calls(65)));
    expect(screen.getByText("Page 1 of 4")).toBeInTheDocument();
    expect(screen.getByText("Showing 1-20 of 65 loaded matching tool calls.")).toBeInTheDocument();
});

it("a superseded detail completion cannot overwrite the payload or status of a newer detail read", async () => {
    const domains = new WebTestDomains(); domains.setInstances([{ name: "alpha" }]);
    const compact = { ...auditCall, input: undefined, output: undefined };
    domains.setToolCalls("alpha", [compact]);
    const old = deferred<typeof auditCall>(), latest = deferred<typeof auditCall>();
    const read = vi.spyOn(domains.toolCalls, "readDetail")
        .mockImplementationOnce(async () => [await old.promise])
        .mockImplementationOnce(async () => [await latest.promise]);
    render(withWebDomains(domains, <Audit store={new WebStore(domains.domains)} navigate={() => undefined}
        route={{ page: "audit", view: "call", instance: "alpha", callId: compact.callId }} />));
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    act(() => domains.setToolCalls("alpha", [{ ...compact, status: "completed", completedAt: "2026-10-20T01:05:00Z" }]));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => latest.resolve({ ...auditCall, input: { command: "LATEST" } }));
    expect(screen.getByText(/LATEST/u)).toBeInTheDocument();
    await act(async () => old.resolve({ ...auditCall, input: { command: "OBSOLETE" } }));
    expect(screen.queryByText(/OBSOLETE/u)).not.toBeInTheDocument();
    expect(screen.getByText(/LATEST/u)).toBeInTheDocument();
    expect(screen.getByText("Completed").nextElementSibling).toHaveTextContent("2026-10-20T01:05:00Z");
    expect(within(screen.getByText("bash_run").closest("summary")!).getByText("completed")).toBeInTheDocument();
});

it("a late detail failure from the previous instance cannot replace the current selection or its successful read", async () => {
    const domains = new WebTestDomains(); domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    const compact = { ...auditCall, input: undefined, output: undefined };
    domains.setToolCalls("alpha", [compact]); domains.setToolCalls("beta", [{ ...compact, instance: "beta" }]);
    const old = deferred<typeof auditCall>();
    const read = vi.spyOn(domains.toolCalls, "readDetail").mockImplementationOnce(async () => [await old.promise])
        .mockResolvedValueOnce([{ ...auditCall, instance: "beta", input: { command: "BETA" } }]);
    const store = new WebStore(domains.domains);
    const view = (instance: string) => withWebDomains(domains, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "call", instance, callId: compact.callId }} />);
    const mounted = render(view("alpha"));
    await waitFor(() => expect(read).toHaveBeenCalledOnce()); mounted.rerender(view("beta"));
    expect(await screen.findByText(/BETA/u)).toBeInTheDocument();
    await act(async () => old.reject(new Error("alpha detail read failed")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(screen.getByText(/BETA/u)).toBeInTheDocument();
    expect(read.mock.calls).toEqual([["alpha", compact.callId], ["beta", compact.callId]]);
});

it("detail read failure permits a deterministic close/open retry", async () => {
    const domains = new WebTestDomains(); domains.setInstances([{ name: "alpha" }]);
    domains.setToolCalls("alpha", [{ ...auditCall, input: undefined, output: undefined }]);
    const read = vi.spyOn(domains.toolCalls, "readDetail").mockRejectedValueOnce(new Error("Audit storage temporarily locked"))
        .mockResolvedValueOnce([{ ...auditCall, input: { command: "recovered-detail" } }]);
    render(withWebDomains(domains, <Audit store={new WebStore(domains.domains)} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: { kind: "all" } }} />));
    fireEvent.click(screen.getByText("bash_run"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit storage temporarily locked");
    fireEvent.click(screen.getByText("bash_run")); fireEvent.click(screen.getByText("bash_run"));
    expect(await screen.findByText(/recovered-detail/u)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(read).toHaveBeenCalledTimes(2);
});

it("approval failures remain request-specific when a reentrant unrelated operation clears global error, then retry reports its new error", async () => {
    const { domains, store } = setupAudit();
    const first = deferred<void>(), second = deferred<void>();
    const decide = vi.spyOn(domains.approval("alpha"), "decide").mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise).mockResolvedValueOnce(undefined);
    let cleared = false;
    const unsubscribe = store.subscribe(() => {
        if (store.state.error === "Approval backend fault A") {
            cleared = true;
            void store.start("beta");
        }
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledOnce());
    await act(async () => first.reject(new Error("Approval backend fault A")));
    unsubscribe();
    expect(cleared).toBe(true);
    expect(store.state.error).toBeUndefined();
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Approval backend fault A");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    await act(async () => second.reject(new Error("Approval backend fault B")));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Approval backend fault B");
    expect(screen.getByRole("dialog")).toHaveTextContent("Review deploy");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(decide).toHaveBeenCalledTimes(3);
});

it("instance-scoped identical approval ids remain independent through pending, failure and retry", async () => {
    const { domains, store, unmount } = setupAudit(); unmount();
    const alpha = domains.approval("alpha").state.approvals[0];
    domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    domains.setApprovals("beta", [{ ...alpha, instance: "beta" }]);
    domains.setToolCalls("beta", [{ ...auditCall, instance: "beta" }]);
    const a = deferred<void>(), b = deferred<void>();
    vi.spyOn(domains.approval("alpha"), "decide").mockReturnValue(a.promise);
    const beta = vi.spyOn(domains.approval("beta"), "decide").mockReturnValueOnce(b.promise).mockResolvedValueOnce(undefined);
    const alphaResult = store.decideTool("alpha", alpha.approvalId, "approve");
    render(withWebDomains(domains, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: { kind: "instance", instance: "beta" } }} />));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(beta).toHaveBeenCalledOnce());
    expect(store.state.operations[approvalOperationKey("alpha", alpha.approvalId)]).toBe("pending");
    expect(store.state.operations[approvalOperationKey("beta", alpha.approvalId)]).toBe("pending");
    await act(async () => b.reject(new Error("Beta policy conflict")));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Beta policy conflict");
    await act(async () => { a.resolve(); await alphaResult; });
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Beta policy conflict");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument()); expect(beta).toHaveBeenCalledTimes(2);
});

it("late approval failure cannot modify a replacement approval review on the same tool call", async () => {
    const { domains } = setupAudit();
    const old = deferred<void>();
    const decide = vi.spyOn(domains.approval("alpha"), "decide").mockReturnValueOnce(old.promise).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledOnce());
    const original = domains.approval("alpha").state.approvals[0];
    act(() => domains.setApprovals("alpha", [{ ...original, approvalId: "replacement", reason: "Replacement review" }]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Replacement review");
    await act(async () => old.reject(new Error("Obsolete approval refused")));
    expect(screen.getByRole("dialog")).toHaveTextContent("Replacement review");
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(decide.mock.calls).toEqual([["approval-alpha", "approve"], ["replacement", "deny"]]);
});
